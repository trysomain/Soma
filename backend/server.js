const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());

const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors({
  origin: allowedOrigin,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  throw new Error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend environment variables.");
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// IMPORTANT: Keep prices on the server. Do not trust prices sent by the browser.
const PRODUCTS = {
  "soma-sol-01": { name: "SOMA SOLSTICE TEE", price: 1499 },
  "soma-arc-02": { name: "OBSIDIAN HEAVY HOODIE", price: 2499 },
  "soma-arc-03": { name: "NOCTURNE BOX TEE", price: 1299 },
  "soma-arc-04": { name: "MONOLITH CARGO PANT", price: 2799 }
};

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/create-order", async (req, res) => {
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
      return res.status(400).json({ error: "Invalid cart." });
    }

    let totalRupees = 0;
    for (const item of items) {
      const product = PRODUCTS[item.id];
      const qty = Number(item.qty);
      const validSizes = ["S", "M", "L", "XL", "XXL"];

      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 10 ||
          !validSizes.includes(item.size)) {
        return res.status(400).json({ error: "Invalid product, quantity, or size." });
      }
      totalRupees += product.price * qty;
    }

    const amount = totalRupees * 100; // Razorpay expects paise.
    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `soma_${Date.now()}`
    });

    return res.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (error) {
    console.error("Create order error:", error);
    return res.status(500).json({ error: "Unable to create payment order." });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ verified: false, error: "Missing payment details." });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest();

    const received = Buffer.from(razorpay_signature, "hex");
    if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) {
      return res.status(400).json({ verified: false, error: "Invalid payment signature." });
    }

    // Also confirm the payment belongs to this order and check its current status.
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id) {
      return res.status(400).json({ verified: false, error: "Payment/order mismatch." });
    }

    // If your Razorpay account uses manual capture, capture/confirm it before fulfilment.
    if (payment.status !== "captured") {
      return res.status(409).json({
        verified: false,
        error: `Signature valid, but payment status is ${payment.status}. Do not fulfil yet.`
      });
    }

    // TODO: Persist the paid order in a database and trigger fulfilment/email here.
    return res.json({ verified: true, paymentId: payment.id, status: payment.status });
  } catch (error) {
    console.error("Verify payment error:", error);
    return res.status(500).json({ verified: false, error: "Unable to verify payment." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`SOMA payment API listening on ${port}`));
