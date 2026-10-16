require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || !process.env.MONGODB_URI || !process.env.ADMIN_PASSWORD) {
  console.warn("Set JWT_SECRET, MONGODB_URI and ADMIN_PASSWORD in your environment.");
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const eventSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, default: "Campus Event", maxlength: 50 },
  description: { type: String, default: "", maxlength: 1500 },
  venue: { type: String, required: true, maxlength: 180 },
  date: { type: String, required: true },
  time: { type: String, required: true, maxlength: 100 },
  capacity: { type: Number, default: 500, min: 1, max: 100000 },
  accent: { type: String, default: "cyan" },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const registrationSchema = new mongoose.Schema({
  event: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  prn: { type: String, required: true, trim: true, maxlength: 40 },
  className: { type: String, required: true, trim: true, maxlength: 40 },
  batch: { type: String, required: true, trim: true, maxlength: 40 },
  academicYear: { type: String, required: true, trim: true, maxlength: 30 },
  branch: { type: String, required: true, trim: true, maxlength: 80 },
  ticketToken: { type: String, required: true, unique: true, index: true },
  registeredAt: { type: Date, default: Date.now },
  checkedInAt: { type: Date, default: null }
});
registrationSchema.index({ event: 1, prn: 1 }, { unique: true });
const Event = mongoose.model("Event", eventSchema);
const Registration = mongoose.model("Registration", registrationSchema);

function adminOnly(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "admin") throw new Error("Wrong role");
    next();
  } catch {
    res.status(401).json({ error: "Please sign in as an administrator." });
  }
}
function cleanText(value, max = 100) {
  return String(value || "").trim().slice(0, max);
}
async function getEventCounts() {
  const events = await Event.find({ active: true }).sort({ createdAt: -1 }).lean();
  const counts = await Registration.aggregate([
    { $group: { _id: "$event", count: { $sum: 1 }, checkedIn: { $sum: { $cond: [{ $ne: ["$checkedInAt", null] }, 1, 0] } } } }
  ]);
  const map = new Map(counts.map(x => [String(x._id), x]));
  return events.map(e => ({ ...e, registrations: map.get(String(e._id))?.count || 0, checkedIn: map.get(String(e._id))?.checkedIn || 0 }));
}

app.get("/api/health", (req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? "connected" : "connecting" }));

app.post("/api/admin/login", async (req, res) => {
  const username = cleanText(req.body.username, 100);
  const password = String(req.body.password || "");
  const expectedUser = process.env.ADMIN_USERNAME || "eesaadmin";
  const expectedPass = process.env.ADMIN_PASSWORD || "";
  const okUser = username === expectedUser;
  const okPass = expectedPass.startsWith("$2") ? await bcrypt.compare(password, expectedPass) : password === expectedPass;
  if (!okUser || !okPass || !JWT_SECRET) return res.status(401).json({ error: "Invalid credentials or server configuration." });
  const token = jwt.sign({ role: "admin", username }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, username });
});

app.get("/api/events", async (req, res) => {
  try { res.json(await getEventCounts()); }
  catch { res.status(503).json({ error: "Events are temporarily unavailable. Please try again shortly." }); }
});

app.post("/api/events/:id/register", async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, active: true });
    if (!event) return res.status(404).json({ error: "This event is not available for registration." });
    const count = await Registration.countDocuments({ event: event._id });
    if (count >= event.capacity) return res.status(409).json({ error: "Registration is full for this event." });
    const data = {
      name: cleanText(req.body.name, 100),
      prn: cleanText(req.body.prn, 40),
      className: cleanText(req.body.className, 40),
      batch: cleanText(req.body.batch, 40),
      academicYear: cleanText(req.body.academicYear, 30),
      branch: cleanText(req.body.branch, 80)
    };
    if (Object.values(data).some(v => !v)) return res.status(400).json({ error: "Please complete every field." });
    const ticketToken = crypto.randomBytes(32).toString("hex");
    const registration = await Registration.create({ event: event._id, ...data, ticketToken });
    const ticket = {
      token: ticketToken,
      participant: data.name,
      event: event.title,
      venue: event.venue,
      date: event.date,
      time: event.time,
      registrationId: String(registration._id)
    };
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(ticket), { width: 320, margin: 2, errorCorrectionLevel: "M" });
    io.emit("registration:update", { eventId: String(event._id) });
    res.status(201).json({ message: "Registration successful.", ticket: { ...ticket, qrDataUrl } });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: "This PRN is already registered for this event." });
    console.error(err);
    res.status(500).json({ error: "Could not complete registration. Please try again." });
  }
});

app.post("/api/admin/events", adminOnly, async (req, res) => {
  try {
    const title = cleanText(req.body.title, 120);
    const venue = cleanText(req.body.venue, 180);
    const date = cleanText(req.body.date, 30);
    const time = cleanText(req.body.time, 100);
    if (!title || !venue || !date || !time) return res.status(400).json({ error: "Title, venue, date and time are required." });
    const event = await Event.create({
      title, venue, date, time,
      category: cleanText(req.body.category || "Campus Event", 50),
      description: cleanText(req.body.description, 1500),
      capacity: Math.max(1, Math.min(100000, Number(req.body.capacity) || 500)),
      accent: ["cyan", "gold", "violet", "pink"].includes(req.body.accent) ? req.body.accent : "cyan",
      active: true
    });
    io.emit("events:update");
    res.status(201).json(event);
  } catch { res.status(500).json({ error: "Could not create event." }); }
});

app.patch("/api/admin/events/:id", adminOnly, async (req, res) => {
  try {
    const update = {};
    ["title", "category", "description", "venue", "date", "time", "accent"].forEach(k => {
      if (req.body[k] !== undefined) update[k] = cleanText(req.body[k], k === "description" ? 1500 : 180);
    });
    if (req.body.capacity !== undefined) update.capacity = Math.max(1, Math.min(100000, Number(req.body.capacity) || 1));
    if (req.body.active !== undefined) update.active = Boolean(req.body.active);
    const event = await Event.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!event) return res.status(404).json({ error: "Event not found." });
    io.emit("events:update");
    res.json(event);
  } catch { res.status(500).json({ error: "Could not update event." }); }
});

app.get("/api/admin/registrations", adminOnly, async (req, res) => {
  try {
    const filter = req.query.event ? { event: req.query.event } : {};
    const rows = await Registration.find(filter).populate("event", "title venue date time").sort({ registeredAt: -1 }).lean();
    res.json(rows.map(r => ({
      id: String(r._id), name: r.name, prn: r.prn, className: r.className, batch: r.batch,
      academicYear: r.academicYear, branch: r.branch, registeredAt: r.registeredAt,
      checkedInAt: r.checkedInAt, event: r.event?.title || "Event", eventId: String(r.event?._id || ""),
      venue: r.event?.venue || "", date: r.event?.date || "", time: r.event?.time || ""
    })));
  } catch { res.status(500).json({ error: "Could not load registrations." }); }
});

app.post("/api/admin/scan", adminOnly, async (req, res) => {
  try {
    const token = cleanText(req.body.token, 300);
    if (!token) return res.status(400).json({ status: "invalid", message: "No ticket token was found." });
    let payload;
    try { payload = JSON.parse(token); } catch { return res.status(400).json({ status: "invalid", message: "This QR code is not an EESA ticket." }); }
    if (!payload.token || !payload.registrationId) return res.status(400).json({ status: "invalid", message: "This QR code is not an EESA ticket." });
    const reg = await Registration.findOne({ _id: payload.registrationId, ticketToken: payload.token }).populate("event", "title venue date time");
    if (!reg) return res.status(404).json({ status: "invalid", message: "Ticket not found or invalid." });
    if (reg.checkedInAt) return res.status(409).json({ status: "already-used", message: "This ticket has already been scanned for this event.", participant: reg.name, event: reg.event.title, checkedInAt: reg.checkedInAt });
    reg.checkedInAt = new Date();
    await reg.save();
    io.emit("checkin:update", { eventId: String(reg.event._id) });
    res.json({ status: "accepted", message: "Entry approved. Welcome!", participant: reg.name, prn: reg.prn, event: reg.event.title, checkedInAt: reg.checkedInAt });
  } catch { res.status(500).json({ status: "error", message: "Scanner could not verify this ticket." }); }
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

async function seedEvents() {
  if (await Event.countDocuments() > 0) return;
  await Event.insertMany([
    {
      title: "EESAVERSE 2.0 — Freshers Party", category: "Flagship • Freshers",
      description: "New faces. Same dreams. Bigger journeys. Meet your EESA community for an evening of music, dance, memories and new beginnings.",
      venue: "Venue to be announced", date: "Coming soon", time: "Coming soon",
      capacity: 1000, accent: "gold"
    },
    {
      title: "Direct Second Year — Welcome Event", category: "DSY • Community",
      description: "A warm welcome for direct second-year students. Meet your classmates, discover EESA and kick-start your engineering journey.",
      venue: "Venue to be announced", date: "Coming soon", time: "Coming soon",
      capacity: 500, accent: "cyan"
    }
  ]);
}
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => { console.log("MongoDB connected"); await seedEvents(); })
  .catch(err => console.error("MongoDB connection failed:", err.message));
server.listen(PORT, () => console.log(`EESA Verse running on port ${PORT}`));
