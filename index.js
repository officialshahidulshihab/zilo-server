const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ── CORS ────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

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
    .updateOne({}, { $setOnInsert: { isOpen: true, message: "" } }, { upsert: true });
  return cachedDb;
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function pad(n) {
  return String(n).padStart(4, "0");
}

const verifyAdmin = (req, res, next) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

// ── PUBLIC ROUTES ────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => res.send("ZILO server running."));

// Service status
app.get("/api/status", async (req, res) => {
  try {
    const db = await getDb();
    const s = await db.collection("status").findOne({});
    res.json({ isOpen: s?.isOpen ?? true, message: s?.message ?? "" });
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

    const body = req.body;
    if (Number(body.amountPaid) < 500) {
      return res.status(400).json({ message: "Minimum order is ৳500." });
    }

    // Auto-increment order ID
    const cnt = await counter.findOneAndUpdate(
      { _id: "orderCount" },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
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
      custName:      body.custName?.trim(),
      phone:         body.phone?.trim(),
      union:         body.union,
      wardArea:      body.wardArea?.trim(),
      villageBari:   body.villageBari?.trim(),
      landmark:      body.landmark?.trim() || "",
      itemName:      body.itemName?.trim(),
      brandName:     body.brandName?.trim(),
      refPhoto:      body.refPhoto?.trim() || "",
      isRepeat:      body.isRepeat === "true",
      shopName:      body.shopName?.trim() || "",
      lastPrice:     body.lastPrice?.trim() || "",
      budget:        body.budget?.trim() || "",
      paymentMethod: body.paymentMethod,
      amountPaid:    Number(body.amountPaid),
      transactionId: body.transactionId?.trim(),
      screenshotUrl,
      isUrgent:      body.isUrgent === "true",
      notes:         body.notes?.trim() || "",
      status:        "Order Received",
      statusNote:    "",
      date: now.toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric",
      }),
      createdAt: now,
    };

    await orders.insertOne(order);
    res.json({ success: true, orderId });
  } catch (err) {
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

    const order = await db.collection("orders").findOne({ orderId: orderId.trim() });
    if (!order) return res.status(404).json({ message: "Not found." });

    const inputPhone  = phone.replace(/\D/g, "").slice(-11);
    const storedPhone = order.phone.replace(/\D/g, "").slice(-11);
    if (inputPhone !== storedPhone) {
      return res.status(404).json({ message: "Not found." });
    }

    res.json({
      orderId:    order.orderId,
      date:       order.date,
      itemName:   order.itemName,
      brandName:  order.brandName,
      status:     order.status,
      statusNote: order.statusNote || "",
    });
  } catch (err) {
    console.error("GET /api/orders/track:", err);
    res.status(500).json({ message: "Server error." });
  }
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
      }))
    );
  } catch (err) {
    console.error("GET /api/admin/orders:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Stats
app.get("/api/admin/stats", verifyAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const all = await db.collection("orders").find().toArray();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayCount = all.filter((o) => new Date(o.createdAt) >= today).length;
    const pending    = all.filter((o) => !["Delivered", "Cancelled"].includes(o.status)).length;
    const revenue    = all
      .filter((o) => o.status !== "Cancelled")
      .reduce((s, o) => s + (o.amountPaid || 0), 0);

    res.json({ total: all.length, today: todayCount, pending, revenue });
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
      { $set: { status: newStatus, statusNote: statusNote || "", updatedAt: new Date() } }
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
      .updateOne({}, { $set: { isOpen: Boolean(isOpen), message: message || "" } });
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