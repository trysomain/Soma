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

// Sandbox-only Qikink authentication check. This never creates an order or returns the token.
app.post("/api/qikink/test", async (_req, res) => {
  if (process.env.QIKINK_SANDBOX_MODE !== "true") {
    return res.status(409).json({ ok: false, error: "Qikink Sandbox mode is not enabled." });
  }

  const clientId = process.env.QIKINK_CLIENT_ID;
  const clientSecret = process.env.QIKINK_SANDBOX_SECRET || process.env.QIKINK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({
      ok: false,
      error: "Missing QIKINK_CLIENT_ID or Sandbox client secret in Render environment."
    });
  }

  try {
    const body = new URLSearchParams({
      ClientId: clientId,
      client_secret: clientSecret
    });
    const response = await fetch("https://sandbox.qikink.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000)
    });

    const data = await response.json().catch(() => ({}));
    const token = data.Accesstoken || data.access_token || data.accessToken;
    if (!response.ok || !token) {
      console.error("Qikink Sandbox auth failed:", response.status, JSON.stringify(data).slice(0, 500));
      return res.status(502).json({
        ok: false,
        error: "Qikink Sandbox did not return an access token. Check the Render environment and Qikink API response.",
        upstreamStatus: response.status
      });
    }

    return res.json({ ok: true, connected: true, environment: "sandbox" });
  } catch (error) {
    console.error("Qikink Sandbox connection error:", error.message);
    return res.status(502).json({
      ok: false,
      error: "Could not reach Qikink Sandbox. Check the service logs and try again."
    });
  }
});

// Sandbox-only plain catalogue order test. Uses a fixed test address and never runs in Live mode.
app.post("/api/qikink/test-order", async (_req, res) => {
  if (process.env.QIKINK_SANDBOX_MODE !== "true") {
    return res.status(409).json({ ok: false, error: "Qikink Sandbox mode is not enabled." });
  }

  const clientId = process.env.QIKINK_CLIENT_ID;
  const clientSecret = process.env.QIKINK_SANDBOX_SECRET || process.env.QIKINK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({ ok: false, error: "Missing Qikink Sandbox credentials." });
  }

  try {
    const tokenBody = new URLSearchParams({ ClientId: clientId, client_secret: clientSecret });
    const tokenResponse = await fetch("https://sandbox.qikink.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
      signal: AbortSignal.timeout(15000)
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    const accessToken = tokenData.Accesstoken || tokenData.access_token || tokenData.accessToken;
    if (!tokenResponse.ok || !accessToken) {
      return res.status(502).json({ ok: false, error: "Could not obtain a Qikink Sandbox access token." });
    }

    const orderNumber = `SOMATEST${Date.now().toString().slice(-6)}`;
    const payload = {
      order_number: orderNumber,
      qikink_shipping: "1",
      gateway: "Prepaid",
      total_order_value: "294",
      line_items: [{
        search_from_my_products: 0,
        sku: "UOsTMRnHs-Wh-S",
        quantity: "1",
        price: "294"
      }],
      shipping_address: {
        first_name: "SOMA",
        last_name: "SANDBOX",
        address1: "Sandbox Test Address",
        address2: "",
        phone: "9999999999",
        email: "sandbox-test@example.com",
        city: "Ludhiana",
        zip: "141001",
        province: "Punjab",
        country_code: "IN"
      }
    };

    const orderResponse = await fetch("https://sandbox.qikink.com/api/order/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ClientId: clientId,
        Accesstoken: accessToken
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
    const orderData = await orderResponse.json().catch(() => ({}));
    if (!orderResponse.ok || orderData.error || orderData.code === 0 || orderData.success === false) {
      console.error("Qikink Sandbox test order rejected:", orderResponse.status, JSON.stringify(orderData).slice(0, 500));
      return res.status(502).json({
        ok: false,
        environment: "sandbox",
        orderNumber,
        error: orderData.message || orderData.msg || orderData.error || "Qikink Sandbox rejected the test order.",
        upstreamStatus: orderResponse.status
      });
    }

    return res.json({
      ok: true,
      environment: "sandbox",
      orderNumber,
      qikinkOrderId: orderData.order_id || orderData.id || null,
      qikinkResponse: orderData
    });
  } catch (error) {
    console.error("Qikink Sandbox test order error:", error.message);
    return res.status(502).json({ ok: false, environment: "sandbox", error: "Could not submit the test order to Qikink Sandbox." });
  }
});

app.post("/api/create-order", async (req, res) => {
  try {
    const items = req.body.items;
    const shipping = req.body.shipping || {};
    if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
      return res.status(400).json({ error: "Invalid cart." });
    }

    const requiredShipping = ["name", "phone", "email", "address1", "city", "state", "pincode"];
    for (const field of requiredShipping) {
      if (typeof shipping[field] !== "string" || !shipping[field].trim()) {
        return res.status(400).json({ error: "Please provide all required shipping details." });
      }
    }
    if (shipping.name.length > 100 || shipping.email.length > 120 ||
        shipping.address1.length > 180 || (shipping.address2 || "").length > 180 ||
        shipping.city.length > 80 || shipping.state.length > 80 ||
        !/^[0-9]{6}$/.test(shipping.pincode) ||
        !/^[0-9+() -]{10,20}$/.test(shipping.phone) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shipping.email)) {
      return res.status(400).json({ error: "Please check your phone, email, PIN code, and address details." });
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
      receipt: `soma_${Date.now()}`,
      notes: {
        customer_name: shipping.name.trim(),
        customer_phone: shipping.phone.trim(),
        customer_email: shipping.email.trim(),
        shipping_address1: shipping.address1.trim(),
        shipping_address2: (shipping.address2 || "").trim(),
        shipping_city: shipping.city.trim(),
        shipping_state: shipping.state.trim(),
        shipping_pincode: shipping.pincode.trim(),
        shipping_country: "India"
      }
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
