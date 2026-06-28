const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: [process.env.CLIENT_URL || "http://localhost:3000"], credentials: true }));
app.use(express.json());

// Serve uploaded screenshots
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s/g, "_")}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const client = new MongoClient(process.env.MONGODB_URI);

const verifyAdmin = (req, res, next) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

function pad(n) { return String(n).padStart(4, "0"); }

async function run() {
  await client.connect();
  const db = client.db(process.env.DB_NAME || "zilodb");
  const orders = db.collection("orders");
  const status = db.collection("status");
  const counter = db.collection("counter");

  // Ensure status doc
  await status.updateOne({}, { $setOnInsert: { isOpen: true, message: "" } }, { upsert: true });

  // ── PUBLIC ROUTES ──────────────────────────────────────

  // Service status
  app.get("/api/status", async (req, res) => {
    const s = await status.findOne({});
    res.json({ isOpen: s?.isOpen ?? true, message: s?.message ?? "" });
  });

  // URL checker
  app.get("/api/check-url", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.json({ ok: false });
    try {
      const fetch = (await import("node-fetch")).default;
      const r = await fetch(url, { method: "HEAD", timeout: 5000 });
      res.json({ ok: r.ok });
    } catch { res.json({ ok: false }); }
  });

  // Place an order
  app.post("/api/orders", upload.single("screenshot"), async (req, res) => {
    const s = await status.findOne({});
    if (!s?.isOpen) return res.status(403).json({ message: "Service is off today." });

    const body = req.body;

    // Validate minimum
    if (Number(body.amountPaid) < 500) {
      return res.status(400).json({ message: "Minimum order is ৳500." });
    }

    // Generate order ID
    const cnt = await counter.findOneAndUpdate(
      { _id: "orderCount" },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    const orderId = `ZIL-${pad(cnt.seq || 1)}`;

    const now = new Date();
    const screenshotUrl = req.file
      ? `${process.env.CLIENT_URL || "http://localhost:5000"}/uploads/${req.file.filename}`
      : "";

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
      transactionId: body.transactionId?.trim(),
      screenshotUrl,
      isUrgent: body.isUrgent === "true",
      notes: body.notes?.trim() || "",
      status: "Order Received",
      statusNote: "",
      date: now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
      createdAt: now,
    };

    await orders.insertOne(order);
    res.json({ success: true, orderId });
  });

  // Track order (public, requires phone match)
  app.get("/api/orders/track", async (req, res) => {
    const { orderId, phone } = req.query;
    if (!orderId || !phone) return res.status(400).json({ message: "Missing fields." });

    const order = await orders.findOne({ orderId: orderId.trim() });
    if (!order) return res.status(404).json({ message: "Not found." });

    // Normalize phone comparison
    const inputPhone = phone.replace(/\D/g, "").slice(-11);
    const storedPhone = order.phone.replace(/\D/g, "").slice(-11);
    if (inputPhone !== storedPhone) return res.status(404).json({ message: "Not found." });

    res.json({
      orderId: order.orderId,
      date: order.date,
      itemName: order.itemName,
      brandName: order.brandName,
      status: order.status,
      statusNote: order.statusNote || "",
    });
  });

  // ── ADMIN ROUTES ───────────────────────────────────────

  // Get all orders
  app.get("/api/admin/orders", verifyAdmin, async (req, res) => {
    const result = await orders.find().sort({ createdAt: -1 }).toArray();
    res.json(result.map((o) => ({ ...o, _id: o._id.toString() })));
  });

  // Stats
  app.get("/api/admin/stats", verifyAdmin, async (req, res) => {
    const all = await orders.find().toArray();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayCount = all.filter((o) => new Date(o.createdAt) >= today).length;
    const pending = all.filter((o) => !["Delivered", "Cancelled"].includes(o.status)).length;
    const revenue = all.filter((o) => o.status !== "Cancelled").reduce((s, o) => s + (o.amountPaid || 0), 0);

    res.json({ total: all.length, today: todayCount, pending, revenue });
  });

  // Update order status
  app.patch("/api/admin/orders/:id/status", verifyAdmin, async (req, res) => {
    const { id } = req.params;
    const { status: newStatus, statusNote } = req.body;
    const valid = ["Order Received", "Payment Verified", "Sourcing", "Out for Delivery", "Delivered", "Cancelled"];
    if (!valid.includes(newStatus)) return res.status(400).json({ message: "Invalid status." });

    await orders.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: newStatus, statusNote: statusNote || "", updatedAt: new Date() } }
    );
    res.json({ success: true });
  });

  // Toggle service status
  app.patch("/api/admin/status", verifyAdmin, async (req, res) => {
    const { isOpen, message } = req.body;
    await status.updateOne({}, { $set: { isOpen: Boolean(isOpen), message: message || "" } });
    res.json({ success: true });
  });

  app.get("/", (req, res) => res.send("ZILO server running."));
}

run().catch(console.dir);

app.listen(PORT, () => console.log(`ZILO server on port ${PORT}`));