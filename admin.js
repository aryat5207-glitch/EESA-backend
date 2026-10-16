const $ = id => document.getElementById(id);
const socket = typeof io === "function" ? io() : null;
let token = sessionStorage.getItem("eesaAdminToken") || "";
let registrations = [];
let adminEvents = [];
let scanner = null;
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function api(url, options={}) {
  const headers = { ...(options.headers||{}), "Content-Type":"application/json", "Authorization":`Bearer ${token}` };
  const response = await fetch(url,{...options,headers});
  const data = await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||data.message||"Request failed");
  return data;
}
function showDashboard(){ $("loginView").classList.add("hidden");$("dashboard").classList.remove("hidden");loadDashboard(); }
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();$("loginMessage").textContent="Signing in…";
  const data=Object.fromEntries(new FormData(e.target).entries());
  try{const r=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw new Error(d.error||"Login failed");token=d.token;sessionStorage.setItem("eesaAdminToken",token);$("loginMessage").textContent="";showDashboard();}
  catch(err){$("loginMessage").textContent=err.message;}
});
$("logoutBtn").addEventListener("click",async()=>{if(scanner)try{await scanner.stop();}catch{};token="";sessionStorage.removeItem("eesaAdminToken");$("dashboard").classList.add("hidden");$("loginView").classList.remove("hidden");});
$("eventForm").addEventListener("submit",async e=>{
  e.preventDefault();$("eventMessage").textContent="Publishing…";
  const data=Object.fromEntries(new FormData(e.target).entries());
  try{await api("/api/admin/events",{method:"POST",body:JSON.stringify(data)});e.target.reset();e.target.elements.capacity.value=500;$("eventMessage").textContent="Event published. The public event board updates automatically.";await loadDashboard();}
  catch(err){$("eventMessage").textContent=err.message;}
});
async function loadDashboard(){await Promise.all([loadEvents(),loadRegistrations()]);}
async function loadEvents(){
  try{
    const events=await fetch("/api/events").then(r=>r.json());
    adminEvents=events;
    const current=$("eventFilter").value;
    $("eventFilter").innerHTML='<option value="">All events</option>'+events.map(e=>`<option value="${esc(e._id)}">${esc(e.title)}</option>`).join("");
    if(events.some(e=>e._id===current))$("eventFilter").value=current;
    const rows=$("eventRows");
    if(rows) rows.innerHTML=events.length?events.map(e=>`<tr><td>${esc(e.title)}</td><td>${esc(e.date)}<br>${esc(e.time)}</td><td>${esc(e.venue)}</td><td><button class="edit-event-btn" data-edit-event="${esc(e._id)}" style="padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:#10253b;color:#52e7ff;cursor:pointer">Edit details</button></td></tr>`).join(""):'<tr><td colspan="4">No published events yet.</td></tr>';
  }catch(err){$("eventMessage").textContent=err.message;}
}
$("eventRows").addEventListener("click", async e=>{
  const btn=e.target.closest("[data-edit-event]"); if(!btn)return;
  const item=adminEvents.find(x=>x._id===btn.dataset.editEvent); if(!item)return;
  const title=prompt("Event title",item.title); if(title===null)return;
  const venue=prompt("Venue",item.venue); if(venue===null)return;
  const date=prompt("Date (for example 20 Nov 2026)",item.date); if(date===null)return;
  const time=prompt("Time (for example 4:00 PM)",item.time); if(time===null)return;
  const capacity=prompt("Registration capacity",item.capacity); if(capacity===null)return;
  const description=prompt("Event description",item.description||""); if(description===null)return;
  try{await api(`/api/admin/events/${encodeURIComponent(item._id)}`,{method:"PATCH",body:JSON.stringify({title,venue,date,time,capacity:Number(capacity),description})});$("manageEventMessage").textContent="Event updated. Public page is refreshing live.";await loadDashboard();}
  catch(err){$("manageEventMessage").textContent=err.message;}
});
async function loadRegistrations(){
  $("dataMessage").textContent="Updating…";
  try{
    const q=$("eventFilter").value;
    registrations=await api("/api/admin/registrations"+(q?"?event="+encodeURIComponent(q):""));
    $("registrationRows").innerHTML=registrations.length?registrations.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.prn)}</td><td>${esc(r.className)} / ${esc(r.batch)}</td><td>${esc(r.event)}</td><td><span class="status-pill ${r.checkedInAt?"yes":""}">${r.checkedInAt?"Checked in":"Not checked in"}</span></td></tr>`).join(""):'<tr><td colspan="5">No registrations for this selection yet.</td></tr>';
    $("dataMessage").textContent=`${registrations.length} registration(s) loaded live.`;
  }catch(err){$("dataMessage").textContent=err.message;if(err.message.toLowerCase().includes("sign in"))$("logoutBtn").click();}
}
$("eventFilter").addEventListener("change",loadRegistrations);
$("refreshBtn").addEventListener("click",loadDashboard);
$("exportBtn").addEventListener("click",()=>{
  const cols=["name","prn","className","batch","academicYear","branch","event","venue","date","time","registeredAt","checkedInAt"];
  const quote=v=>`"${String(v??"").replace(/"/g,'""')}"`;
  const csv=[cols.join(","),...registrations.map(r=>cols.map(c=>quote(r[c])).join(","))].join("\r\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="eesa-registrations.csv";a.click();URL.revokeObjectURL(a.href);
});
async function verifyTicket(raw){
  const result=$("scanResult");result.className="";result.textContent="Verifying ticket…";
  try{
    const data=await api("/api/admin/scan",{method:"POST",body:JSON.stringify({token:raw})});
    result.className="scanner-result ok";
    result.innerHTML=`<strong>✓ ENTRY APPROVED</strong><br>${esc(data.participant)} · ${esc(data.prn)}<br>${esc(data.event)}<br>${esc(data.message)}`;
    loadRegistrations();
  }catch(err){
    result.className="scanner-result bad";
    result.textContent=err.message;
  }
}
async function startScanner(){
  if(!window.Html5Qrcode){$("scanResult").textContent="Camera scanner library did not load. Try refreshing or use a phone browser with internet access.";return;}
  try{
    if(!scanner)scanner=new Html5Qrcode("reader");
    await scanner.start({facingMode:"environment"},{fps:10,qrbox:{width:240,height:240}},async decoded=>{
      await scanner.pause(true);
      await verifyTicket(decoded);
      setTimeout(()=>{if(scanner)scanner.resume();},1800);
    },()=>{});
    $("scanResult").textContent="Camera is active. Point it at an EESA participant QR pass.";
  }catch(err){$("scanResult").className="scanner-result bad";$("scanResult").textContent="Could not start camera. Allow camera permission and use HTTPS, or paste the QR text below. "+err;}
}
$("startScanner").addEventListener("click",startScanner);
$("stopScanner").addEventListener("click",async()=>{if(scanner&&scanner.isScanning){try{await scanner.stop();$("scanResult").textContent="Scanner stopped.";}catch{}}});
$("manualScan").addEventListener("click",()=>verifyTicket($("manualTicket").value.trim()));
if(socket){socket.on("registration:update",loadRegistrations);socket.on("checkin:update",loadRegistrations);socket.on("events:update",loadDashboard);}
if(token)showDashboard();
