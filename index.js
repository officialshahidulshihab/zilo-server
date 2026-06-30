const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ── CORS ────────────────────────────────────────────────────────────────────
// credentials: true is required so the browser will send/receive the
// httpOnly admin session cookie used below.
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// ── MULTER — memory storage (works on Vercel; no writable filesystem needed) ─
// Screenshots are stored as base64 data-URIs in MongoDB.
// Fine for a low-volume delivery service (typical screenshot < 500 KB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ── CACHED MONGODB CONNECTION ────────────────────────────────────────────────
// Vercel reuses warm Lambda instances, so we cache the connection object.
// A fresh cold-start will reconnect automatically.
let cachedClient = null;
let cachedDb = null;

const rateLimit = require("express-rate-limit");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5, // 5 attempts per IP per window
  message: { message: "Too many login attempts. Try again later." },
});

async function getDb() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(process.env.MONGODB_URI, {
    // Keeps the connection alive across serverless invocations
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  cachedClient = client;
  cachedDb = client.db(process.env.DB_NAME || "zilodb");
  // Seed the status document once
  await cachedDb
    .collection("status")
    .updateOne(
      {},
      { $setOnInsert: { isOpen: true, message: "" } },
      { upsert: true },
    );

  // Prevent duplicate transaction IDs among active (non-cancelled) orders.
  // This is a safety net under the app-level check in POST /api/orders —
  // it stops a race condition where two requests with the same TxID land
  // at almost the same time and both pass the findOne() check below.
  //
  // IMPORTANT: scoped to (transactionId + paymentMethod) together, not
  // transactionId alone. bKash and Nagad are separate systems that issue
  // TxIDs independently — "9F7K2LX1QZ" from bKash and "9F7K2LX1QZ" from
  // Nagad are two different real payments that just happen to share a
  // string. Indexing transactionId alone would wrongly treat those as
  // the same payment and block the second customer's real order.
  try {
    // Clean up the OLD single-field index from before this fix existed.
    // If it's still there, MongoDB enforces it *alongside* the new compound
    // index below — so even though the app-level findOne() check correctly
    // allows the same TxID under a different paymentMethod, the insertOne()
    // would still be rejected by this leftover index. Must drop it first.
    const existingIndexes = await cachedDb.collection("orders").indexes();
    const hasLegacyIndex = existingIndexes.some(
      (idx) => idx.name === "uniq_active_transactionId",
    );
    if (hasLegacyIndex) {
      await cachedDb
        .collection("orders")
        .dropIndex("uniq_active_transactionId");
      console.log("Dropped legacy index uniq_active_transactionId");
    }
  } catch (err) {
    console.error("Legacy index cleanup failed (continuing):", err.message);
  }

  try {
    await cachedDb.collection("orders").createIndex(
      { transactionId: 1, paymentMethod: 1 },
      {
        unique: true,
        partialFilterExpression: {
          status: {
            $in: [
              "Order Received",
              "Payment Verified",
              "Sourcing",
              "Out for Delivery",
              "Delivered",
            ],
          },
        },
        name: "uniq_active_transactionId_paymentMethod",
      },
    );
  } catch (err) {
    // If old duplicate TxIDs already exist in the collection, index creation
    // will fail. The server still runs fine without it — the app-level
    // check in POST /api/orders is the primary guard either way.
    console.error(
      "Index creation failed (continuing without it):",
      err.message,
    );
  }

  return cachedDb;
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function pad(n) {
  return String(n).padStart(4, "0");
}

// ── ORDER WINDOW SCHEDULE ────────────────────────────────────────────────────
// Bangladesh (Asia/Dhaka) is a fixed UTC+6 all year — no daylight saving —
// so "what time is it in Dhaka" can be computed by shifting the UTC
// timestamp forward 6 hours and reading it back with the UTC getters.
// No timezone library, no cron job: this is recalculated fresh on every
// request, so it's always accurate to the second and can't drift or miss
// a trigger the way a scheduled job could.
//
// Daily cycle:
//   00:00 – 12:00  → OPEN    "order now, delivered today evening"
//   12:00 – 18:00  → CLOSED  sourcing & delivering today's batch
//   18:00 – 24:00  → OPEN    "order now, delivered tomorrow"
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;

function getOrderWindowStatus(now = new Date()) {
  const bd = new Date(now.getTime() + BD_OFFSET_MS);
  const minutesNow = bd.getUTCHours() * 60 + bd.getUTCMinutes();

  const NOON = 12 * 60;
  const SIX_PM = 18 * 60;

  // Midnight today in BD wall time, converted back to a real UTC instant —
  // used as the zero-point for building exact transition timestamps.
  const bdMidnight = new Date(bd);
  bdMidnight.setUTCHours(0, 0, 0, 0);
  const realMidnight = new Date(bdMidnight.getTime() - BD_OFFSET_MS);
  const toReal = (minutesFromMidnight) =>
    new Date(realMidnight.getTime() + minutesFromMidnight * 60 * 1000);

  if (minutesNow < NOON) {
    return {
      phase: "morning",
      acceptingOrders: true,
      etaText: "today evening",
      nextTransitionAt: toReal(NOON).toISOString(),
    };
  }
  if (minutesNow < SIX_PM) {
    return {
      phase: "midday-closed",
      acceptingOrders: false,
      etaText: null,
      nextTransitionAt: toReal(SIX_PM).toISOString(),
    };
  }
  return {
    phase: "evening",
    acceptingOrders: true,
    etaText: "tomorrow",
    nextTransitionAt: toReal(NOON + 24 * 60).toISOString(), // next day's noon
  };
}

// ── ADMIN SESSION (cookie-based) ─────────────────────────────────────────────
// The raw ADMIN_KEY is checked ONCE at login, server-side, and never sent to
// the browser again. After that, the browser only holds an opaque, signed
// session token in an httpOnly cookie — invisible to JS, invisible in any
// bundled frontend code, and useless on its own if stolen via XSS (it's not
// the actual admin key, and it's scoped + expiring).
const SESSION_COOKIE = "zilo_admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSessionSecret() {
  // Falls back to ADMIN_KEY only if SESSION_SECRET isn't set, so this still
  // works immediately without forcing you to add a new env var today — but
  // setting a separate SESSION_SECRET in .env is recommended (see notes).
  return process.env.SESSION_SECRET || process.env.ADMIN_KEY || "dev-secret";
}

function signSession(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto
    .createHmac("sha256", getSessionSecret())
    .update(data)
    .digest("hex");
  return Buffer.from(data).toString("base64url") + "." + sig;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [dataB64, sig] = token.split(".");
  let data;
  try {
    data = Buffer.from(dataB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expectedSig = crypto
    .createHmac("sha256", getSessionSecret())
    .update(data)
    .digest("hex");
  // Constant-time comparison to avoid timing attacks on the signature check.
  const sigBuf = Buffer.from(sig || "", "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  const parsed = JSON.parse(data);
  if (!parsed.exp || Date.now() > parsed.exp) return null; // expired
  return parsed;
}

const verifyAdmin = (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = verifySession(token);
  if (!session || session.role !== "admin") {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

const checkOrigin = (req, res, next) => {
  const allowed = process.env.CLIENT_URL;
  if (req.headers.origin !== allowed) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

// ── PUBLIC ROUTES ────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => res.send("ZILO server running."));

// Service status — merges the admin's manual day-off override (used for
// exam days, holidays — see /api/admin/status) with the automatic
// morning / midday-closed / evening schedule.
app.get("/api/status", async (req, res) => {
  try {
    const db = await getDb();
    const s = await db.collection("status").findOne({});
    const window = getOrderWindowStatus();

    // Manual override always wins: if the admin explicitly paused the whole
    // day, that's a full closure regardless of what time it is.
    if (s?.isOpen === false) {
      return res.json({
        isOpen: false,
        message: s.message || "We're not running today. Check back tomorrow.",
        phase: "manual-closed",
        etaText: null,
        nextTransitionAt: null,
      });
    }

    // Otherwise the automatic schedule decides.
    res.json({
      isOpen: window.acceptingOrders,
      message: window.acceptingOrders
        ? ""
        : "Orders are paused while we source & deliver today's batch. Back online at 6 PM.",
      phase: window.phase,
      etaText: window.etaText,
      nextTransitionAt: window.nextTransitionAt,
    });
  } catch (err) {
    console.error("GET /api/status:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// URL reachability checker
app.get("/api/check-url", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({ ok: false });
  try {
    // node-fetch v2 is CommonJS-compatible; v3+ is ESM-only
    const fetch = require("node-fetch");
    const r = await fetch(url, { method: "HEAD", timeout: 5000 });
    res.json({ ok: r.ok });
  } catch {
    res.json({ ok: false });
  }
});

// Check if a Transaction ID has already been used for a given payment
// method (lets the frontend warn the customer before they submit — the
// real block happens in POST /api/orders). Scoped to paymentMethod too:
// bKash and Nagad TxIDs are independent, so the same string under a
// different method is not a duplicate.
app.get("/api/check-txid", async (req, res) => {
  try {
    const db = await getDb();
    const { txid, paymentMethod } = req.query;
    if (!txid || !paymentMethod) return res.json({ available: true });
    const normalized = txid.trim().toUpperCase();
    const existing = await db.collection("orders").findOne({
      transactionId: normalized,
      paymentMethod,
      status: { $ne: "Cancelled" },
    });
    res.json({ available: !existing });
  } catch (err) {
    console.error("GET /api/check-txid:", err);
    res.json({ available: true }); // fail open — submit-time check still protects you
  }
});

// Place an order
app.post("/api/orders", upload.single("screenshot"), async (req, res) => {
  try {
    const db = await getDb();
    const orders = db.collection("orders");
    const status = db.collection("status");
    const counter = db.collection("counter");

    const s = await status.findOne({});
    if (!s?.isOpen) {
      return res.status(403).json({ message: "Service is off today." });
    }

    // Re-check the automatic midday closure server-side too — the frontend
    // disables the form during this window, but a direct API call must be
    // blocked here regardless, the same way the manual isOpen check above is.
    const window = getOrderWindowStatus();
    if (!window.acceptingOrders) {
      return res.status(403).json({
        message:
          "Orders are paused 12 PM–6 PM while we source & deliver today's batch. Please try again after 6 PM.",
      });
    }

    const body = req.body;

    // FIX: this was `Number(body.amountPaid && body.budget) < 500`, which used
    // the `&&` operator (not a comparison) and silently rejected any order
    // where the optional `budget` field was left blank, regardless of the
    // real amount paid. It must check amountPaid alone.
    if (Number(body.amountPaid) < 500) {
      return res.status(400).json({ message: "Minimum order is ৳500." });
    }

    // ── Duplicate TxID guard ──────────────────────────────────────────
    // Scoped to (transactionId + paymentMethod) together — bKash and
    // Nagad issue TxIDs independently, so the same string under different
    // methods is not actually a duplicate payment.
    const normalizedTxId = body.transactionId?.trim().toUpperCase();
    if (!normalizedTxId) {
      return res.status(400).json({ message: "Transaction ID is required." });
    }
    if (!body.paymentMethod) {
      return res.status(400).json({ message: "Payment method is required." });
    }
    const duplicate = await orders.findOne({
      transactionId: normalizedTxId,
      paymentMethod: body.paymentMethod,
      status: { $ne: "Cancelled" },
    });
    if (duplicate) {
      return res.status(409).json({
        message:
          "This Transaction ID has already been used for another order with this payment method. If this is a mistake, message us on WhatsApp with your bKash/Nagad confirmation SMS.",
      });
    }

    // Auto-increment order ID
    const cnt = await counter.findOneAndUpdate(
      { _id: "orderCount" },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    const orderId = `ZIL-${pad(cnt.seq || 1)}`;

    // Convert uploaded screenshot to base64 data-URI so it survives across
    // serverless invocations (no persistent filesystem on Vercel).
    let screenshotUrl = "";
    if (req.file) {
      const mime = req.file.mimetype || "image/jpeg";
      screenshotUrl = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
    }

    const now = new Date();
    const order = {
      orderId,
      custName: body.custName?.trim(),
      phone: body.phone?.trim(),
      union: body.union,
      wardArea: body.wardArea?.trim(),
      villageBari: body.villageBari?.trim(),
      landmark: body.landmark?.trim() || "",
      itemName: body.itemName?.trim(),
      brandName: body.brandName?.trim(),
      refPhoto: body.refPhoto?.trim() || "",
      isRepeat: body.isRepeat === "true",
      shopName: body.shopName?.trim() || "",
      lastPrice: body.lastPrice?.trim() || "",
      budget: body.budget?.trim() || "",
      paymentMethod: body.paymentMethod,
      amountPaid: Number(body.amountPaid),
      // FIX: store the normalized (trimmed + uppercased) TxID — same value
      // used in the duplicate check above — so future lookups stay consistent.
      transactionId: normalizedTxId,
      screenshotUrl,
      isUrgent: body.isUrgent === "true",
      notes: body.notes?.trim() || "",
      status: "Order Received",
      statusNote: "",
      date: now.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
      createdAt: now,
    };

    await orders.insertOne(order);
    res.json({ success: true, orderId });
  } catch (err) {
    // Catches the rare race condition: two submissions with the same TxID
    // both pass the findOne() check above at nearly the same instant.
    // The unique index created in getDb() throws error code 11000 here.
    if (err.code === 11000) {
      return res.status(409).json({
        message: "This Transaction ID has already been used for another order.",
      });
    }
    console.error("POST /api/orders:", err);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Track order (public — requires phone match)
app.get("/api/orders/track", async (req, res) => {
  try {
    const db = await getDb();
    const { orderId, phone } = req.query;
    if (!orderId || !phone) {
      return res.status(400).json({ message: "Missing fields." });
    }

    const order = await db
      .collection("orders")
      .findOne({ orderId: orderId.trim() });
    if (!order) return res.status(404).json({ message: "Not found." });

    const inputPhone = phone.replace(/\D/g, "").slice(-11);
    const storedPhone = order.phone.replace(/\D/g, "").slice(-11);
    if (inputPhone !== storedPhone) {
      return res.status(404).json({ message: "Not found." });
    }

    res.json({
      orderId: order.orderId,
      date: order.date,
      itemName: order.itemName,
      brandName: order.brandName,
      status: order.status,
      statusNote: order.statusNote || "",
    });
  } catch (err) {
    console.error("GET /api/orders/track:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── ADMIN AUTH ROUTES ────────────────────────────────────────────────────────

// Login — the ONLY place the raw admin key is ever checked. The key itself
// travels over HTTPS in this one request body and is never stored client-side
// or echoed back; only the signed session cookie is set in response.
app.post("/api/admin/login", (req, res) => {
  const { key } = req.body;
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ message: "Wrong key." });
  }

  const token = signSession({
    role: "admin",
    exp: Date.now() + SESSION_TTL_MS,
  });

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,       // always true — Vercel is always HTTPS
    sameSite: "none",   // required for cross-site (zilo-client ↔ zilo-server)
    maxAge: SESSION_TTL_MS,
    path: "/",
  });

  res.json({ success: true });
});

// Logout — clears the session cookie.
app.post("/api/admin/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
  res.json({ success: true });
});

// Session check — lets the frontend know on page load whether the existing
// cookie (if any) is still valid, without needing to hit a data route first.
app.get("/api/admin/me", (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = verifySession(token);
  res.json({ authed: !!session });
});

// ── ADMIN ROUTES ─────────────────────────────────────────────────────────────

// All orders
app.get("/api/admin/orders", verifyAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db
      .collection("orders")
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    // Strip the base64 blob from the list view to keep payloads small;
    // the admin expands a single order to see the screenshot inline.
    res.json(
      result.map((o) => ({
        ...o,
        _id: o._id.toString(),
        // Keep screenshotUrl — admin panel renders it as <img src={...} />
        // which works fine with data-URIs.
      })),
    );
  } catch (err) {
    console.error("GET /api/admin/orders:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Stats — computed entirely in MongoDB via a single aggregation pipeline.
// Previously this did find().toArray() on the WHOLE orders collection
// (including base64 screenshot blobs) just to count 4 numbers — that's
// both slow and memory-heavy once you're past a few hundred orders.
// $facet runs all four sub-pipelines in one DB round trip; only 4 small
// numbers ever leave Mongo and get loaded into Node memory.
app.get("/api/admin/stats", verifyAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [result] = await db
      .collection("orders")
      .aggregate([
        {
          $facet: {
            total: [{ $count: "count" }],
            today: [
              { $match: { createdAt: { $gte: today } } },
              { $count: "count" },
            ],
            pending: [
              { $match: { status: { $nin: ["Delivered", "Cancelled"] } } },
              { $count: "count" },
            ],
            revenue: [
              { $match: { status: { $ne: "Cancelled" } } },
              { $group: { _id: null, sum: { $sum: "$amountPaid" } } },
            ],
          },
        },
      ])
      .toArray();

    res.json({
      total: result.total[0]?.count || 0,
      today: result.today[0]?.count || 0,
      pending: result.pending[0]?.count || 0,
      revenue: result.revenue[0]?.sum || 0,
    });
  } catch (err) {
    console.error("GET /api/admin/stats:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Update order status
app.patch("/api/admin/orders/:id/status", verifyAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { status: newStatus, statusNote } = req.body;
    const valid = [
      "Order Received",
      "Payment Verified",
      "Sourcing",
      "Out for Delivery",
      "Delivered",
      "Cancelled",
    ];
    if (!valid.includes(newStatus)) {
      return res.status(400).json({ message: "Invalid status." });
    }

    await db.collection("orders").updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: newStatus,
          statusNote: statusNote || "",
          updatedAt: new Date(),
        },
      },
    );
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /api/admin/orders/:id/status:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Toggle service open/closed
app.patch("/api/admin/status", verifyAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { isOpen, message } = req.body;
    await db
      .collection("status")
      .updateOne(
        {},
        { $set: { isOpen: Boolean(isOpen), message: message || "" } },
      );
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /api/admin/status:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── EXPORT ───────────────────────────────────────────────────────────────────
// Vercel imports this file as a module and calls the exported handler.
// For local development, `node index.js` still starts the server normally.
if (require.main === module) {
  app.listen(PORT, () => console.log(`ZILO server on port ${PORT}`));
}

module.exports = app;