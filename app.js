const socket = typeof io === "function" ? io() : null;
const eventGrid = document.getElementById("eventGrid");
const modal = document.getElementById("registerModal");
const form = document.getElementById("registerForm");
const ticketPanel = document.getElementById("ticketPanel");
const formMessage = document.getElementById("formMessage");
let eventsCache = [];
let currentTicket = null;
document.getElementById("year").textContent = new Date().getFullYear();

const symbols = { gold: "✦", cyan: "ϟ", violet: "⌘", pink: "✳" };
function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
function eventCard(e, i) {
  const accent = ["gold","cyan","violet","pink"].includes(e.accent) ? e.accent : "cyan";
  return `<article class="event-card ${accent}">
    <div class="event-top"><span class="event-tag">${safe(e.category || "Campus Event")}</span><span class="event-index">0${i+1} / EESA</span></div>
    <div class="event-visual"><div class="ring">${symbols[accent]}</div></div>
    <h3>${safe(e.title)}</h3><p>${safe(e.description || "Discover the next EESA experience. Connect, learn and make memories with your campus community.")}</p>
    <div class="event-meta"><span>⌖ <b>${safe(e.venue || "Venue to be announced")}</b></span><span>◷ <b>${safe(e.date || "Coming soon")} · ${safe(e.time || "Coming soon")}</b></span></div>
    <div class="event-footer"><span class="event-count"><strong>${Number(e.registrations || 0)}</strong> registered · <strong>${Math.max(0,Number(e.capacity || 0)-Number(e.registrations || 0))}</strong> seats left</span><button class="event-register" data-register="${safe(e._id)}">REGISTER ↗</button></div>
  </article>`;
}
async function loadEvents() {
  try {
    const response = await fetch("/api/events");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Events unavailable");
    eventsCache = data;
    eventGrid.innerHTML = data.length ? data.map(eventCard).join("") : '<div class="loading-card">No events yet. Check back soon.</div>';
  } catch {
    eventGrid.innerHTML = '<div class="loading-card">We could not connect to the live event board. Please refresh in a moment.</div>';
  }
}
function openRegistration(id) {
  const e = eventsCache.find(x => x._id === id);
  if (!e) return;
  document.getElementById("eventId").value = id;
  document.getElementById("modalTitle").textContent = e.title;
  document.getElementById("modalInfo").textContent = `${e.date} · ${e.time} · ${e.venue}`;
  form.reset();
  form.classList.remove("hidden");
  ticketPanel.classList.add("hidden");
  formMessage.textContent = "";
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeModal() {
  modal.classList.add("hidden");
  document.body.style.overflow = "";
}
eventGrid.addEventListener("click", e => {
  const button = e.target.closest("[data-register]");
  if (button) openRegistration(button.dataset.register);
});
document.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", closeModal));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
form.addEventListener("submit", async e => {
  e.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = "Creating your pass…";
  formMessage.textContent = "";
  const data = Object.fromEntries(new FormData(form).entries());
  const eventId = document.getElementById("eventId").value;
  try {
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Registration failed");
    currentTicket = result.ticket;
    form.classList.add("hidden");
    ticketPanel.classList.remove("hidden");
    document.getElementById("ticketQR").src = result.ticket.qrDataUrl;
    document.getElementById("ticketDetails").innerHTML = `<strong>${safe(result.ticket.participant)}</strong><br>${safe(result.ticket.event)}<br>${safe(result.ticket.date)} · ${safe(result.ticket.time)}<br>${safe(result.ticket.venue)}`;
    loadEvents();
  } catch (err) {
    formMessage.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "Register & generate QR pass ↗";
  }
});
document.getElementById("downloadTicket").addEventListener("click", () => {
  if (!currentTicket) return;
  const a = document.createElement("a");
  a.href = currentTicket.qrDataUrl;
  a.download = `EESA-${currentTicket.event.replace(/[^a-z0-9]+/gi,"-")}-QR.png`;
  a.click();
});
document.getElementById("menuBtn").addEventListener("click", () => document.querySelector(".nav-links").classList.toggle("open"));
document.querySelectorAll(".nav-links a").forEach(a => a.addEventListener("click", () => document.querySelector(".nav-links").classList.remove("open")));
if (socket) {
  socket.on("registration:update", loadEvents);
  socket.on("events:update", loadEvents);
}
loadEvents();
