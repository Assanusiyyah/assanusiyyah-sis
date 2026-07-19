import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import { printHtmlDoc, downloadHtmlDocAsPDF, shareHtmlDoc, exportTableToExcel, exportTableToPDF, shareTableAsPDF, downloadNodeAsPDF, shareNode } from "./exportUtils";

// ══════════════════════════════════════════════════════
// SUPABASE — calls our secure /api/db proxy.
// No keys in the browser. Ever.
// ══════════════════════════════════════════════════════
function getSeedMap(){
  return {
    students:SEED_STUDENTS, staff:SEED_STAFF, attendance:SEED_ATTENDANCE,
    results:SEED_RESULTS, fees:SEED_FEES, expenditure:SEED_EXPENDITURE,
    lessons:SEED_LESSONS, assignments:SEED_ASSIGNMENTS, submissions:SEED_SUBMISSIONS,
    messages:SEED_MESSAGES, diary:SEED_DIARY, gallery:SEED_GALLERY,
    elibrary:SEED_ELIBRARY, clinic:SEED_CLINIC, conduct:SEED_CONDUCT,
    timetable:SEED_TIMETABLE, promotions:SEED_PROMOTIONS,
    settings:[SEED_SETTINGS], admins_list:[], school_assets:[],
  };
}

// ── Auth token ────────────────────────────────────────
// Set once on successful login (see LoginScreen); attached to every
// /api/db and /api/admin call so the server can verify who's asking.
let _authToken = null;
function setAuthToken(token){
  _authToken = token;
  try{ if(token) sessionStorage.setItem("asis_token", token); else sessionStorage.removeItem("asis_token"); }catch(e){}
}
function getAuthToken(){
  if(_authToken) return _authToken;
  try{ _authToken = sessionStorage.getItem("asis_token") || null; }catch(e){}
  return _authToken;
}
function authFetchHeaders(){
  const h = {"Content-Type":"application/json"};
  const token = getAuthToken();
  if(token) h["Authorization"] = "Bearer "+token;
  return h;
}

// ── Proxy helpers ───────────────────────────────────
async function dbCall(body){
  try {
    const res = await fetch("/api/db", {
      method:"POST",
      headers: authFetchHeaders(),
      body: JSON.stringify(body)
    });
    if(!res.ok){ const t=await res.text(); console.error("[DB]",t); return null; }
    return await res.json();
  } catch(e){ console.error("[DB]",e.message); return null; }
}

async function adminCall(body){
  try {
    const res = await fetch("/api/admin", {
      method:"POST",
      headers: authFetchHeaders(),
      body: JSON.stringify(body)
    });
    if(!res.ok){ const t=await res.text(); console.error("[Admin]",t); return null; }
    return await res.json();
  } catch(e){ console.error("[Admin]",e.message); return null; }
}

async function sbSelect(table){
  const data = await dbCall({table, method:"SELECT", limit:5000});
  return Array.isArray(data) ? data : null;
}

async function sbUpsertRow(table, id, data){
  const result = await dbCall({table, method:"UPSERT", id, data});
  if(result && result.ok === false){
    console.error("[UPSERT FAILED]", table, id, result.error||result.status);
    throw new Error("DB save failed: "+table+" "+id+" — "+(result.error||result.status));
  }
  return result;
}

async function sbDeleteRow(table, id){
  await dbCall({table, method:"DELETE", id});
}

async function sbUpsertMany(table, items){
  if(!items||!items.length) return;
  await dbCall({table, method:"UPSERT_MANY", data:items});
}

// Tables stored as a single "singleton" row (like settings) rather than one
// row per item — sbLoad unwraps these to the row's data instead of an array.
const SINGLETON_TABLES = ["settings","exam_marks"];

async function sbLoad(table){
  const rows = await sbSelect(table);
  const isSingleton = SINGLETON_TABLES.indexOf(table) !== -1;
  if(rows && rows.length>0){
    return isSingleton ? rows[0] : rows;
  }
  const seed = getSeedMap()[table];
  if(!seed) return isSingleton ? (table==="settings"?SEED_SETTINGS:{}) : [];
  const items = Array.isArray(seed) ? seed : [seed];
  await sbUpsertMany(table, items.map(function(item,i){ return {...item, id:item.id||String(i)}; }));
  return isSingleton ? (table==="settings"?SEED_SETTINGS:seed) : (Array.isArray(seed)?seed:[]);
}

// ── Offline queue helpers ─────────────────────────────
var _offlineQueue = [];
function queueOfflineOp(op){ _offlineQueue.push(op); try{ localStorage.setItem("asis_queue", JSON.stringify(_offlineQueue)); }catch(e){} }
function loadOfflineQueue(){ try{ var q=localStorage.getItem("asis_queue"); if(q) _offlineQueue=JSON.parse(q)||[]; }catch(e){} }
async function flushOfflineQueue(onStatus){
  loadOfflineQueue();
  if(!_offlineQueue.length) return;
  var toProcess = [..._offlineQueue];
  _offlineQueue = [];
  try{ localStorage.removeItem("asis_queue"); }catch(e){}
  var failed = [];
  for(var i=0;i<toProcess.length;i++){
    var op = toProcess[i];
    try{
      if(op.type==="upsert") await sbUpsertRow(op.table, op.id, op.data);
      else if(op.type==="delete") await sbDeleteRow(op.table, op.id);
    } catch(e){ failed.push(op); }
  }
  if(failed.length){ _offlineQueue=failed; try{ localStorage.setItem("asis_queue",JSON.stringify(failed)); }catch(e){} }
  if(onStatus) onStatus(toProcess.length-failed.length, failed.length);
}

// Debounce timers for makeSynced
var _syncTimers = {};

// Last-synced-to-server snapshot per table. Used as the diff baseline instead
// of the debounce closure's own `prev` — rapid successive edits within one
// debounce window cancel each other's timers, so `prev` at the surviving
// timer can already reflect earlier, never-actually-uploaded edits. Diffing
// against this persistent baseline (updated only when a sync actually fires)
// guarantees every changed item gets uploaded, even when its own timer got
// cancelled. Call markSynced() once after loading a table's initial data so
// the very first edit only uploads what actually changed, not everything.
var _lastSynced = {};
function markSynced(table, data){ _lastSynced[table] = data||[]; }

function makeSynced(table, setter, isObject){
  return function(valOrFn){
    setter(function(prev){
      const next = typeof valOrFn==="function" ? valOrFn(prev) : valOrFn;
      // Debounce: wait 1.5s after last change before saving to Supabase
      if(_syncTimers[table]) clearTimeout(_syncTimers[table]);
      _syncTimers[table] = setTimeout(function(){
      if(isObject){
        sbUpsertRow(table, "singleton", next).catch(function(){
          queueOfflineOp({type:"upsert",table:table,id:"singleton",data:next});
        });
      } else {
        const baseline = _lastSynced[table] || [];
        const baselineById = new Map(baseline.map(function(x){return [String(x.id), x];}));
        const nextIds = new Set((next||[]).map(function(x){return String(x.id);}));
        (next||[]).forEach(function(item){
          const prior = baselineById.get(String(item.id));
          if(!prior || JSON.stringify(prior) !== JSON.stringify(item)){
            sbUpsertRow(table, item.id, item).catch(function(){
              queueOfflineOp({type:"upsert",table:table,id:item.id,data:item});
            });
          }
        });
        baselineById.forEach(function(_unused, id){
          if(!nextIds.has(id)) sbDeleteRow(table, id).catch(function(){
            queueOfflineOp({type:"delete",table:table,id:id});
          });
        });
      }
      _lastSynced[table] = next;
      }, 1500); // 1.5 second debounce
      return next;
    });
  };
}

// ── DB Status indicator ─────────────────────────────
function DBStatusBadge({status, onFlush}){
  var _q = useState(0); var qCount = _q[0]; var setQCount = _q[1];
  var _flushing = useState(false); var flushing = _flushing[0]; var setFlushing = _flushing[1];
  var _msg = useState(""); var msg = _msg[0]; var setMsg = _msg[1];

  // Check queue size every 5 seconds
  useState(function(){
    var timer = setInterval(function(){
      try{ var q=localStorage.getItem("asis_queue"); setQCount(q?JSON.parse(q).length:0); }catch(e){}
    },5000);
    return function(){ clearInterval(timer); };
  });

  async function flush(){
    setFlushing(true); setMsg("");
    await flushOfflineQueue(function(sent,failed){
      setMsg(sent+" saved"+(failed>0?", "+failed+" failed":""));
      setQCount(failed);
    });
    setFlushing(false);
    setTimeout(function(){setMsg("");},4000);
  }

  var configs = {
    loading:{bg:"#FEF3C7",color:"#92400E",text:"⏳ Connecting..."},
    online:{bg:"#D1FAE5",color:"#065F46",text:"✅ Database connected"},
    offline:{bg:"#FEE2E2",color:"#991B1B",text:"⚠️ Offline — saving locally"},
    seeding:{bg:"#EFF6FF",color:"#1E40AF",text:"🌱 Setting up..."},
  };
  var cfg = configs[status]||configs.offline;
  return(
    <div style={{position:"fixed",bottom:16,right:16,zIndex:999,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
      {qCount>0 && (
        <div style={{background:"#FEF3C7",color:"#92400E",padding:"5px 12px",borderRadius:16,fontSize:10,fontWeight:600,boxShadow:"0 2px 8px rgba(0,0,0,0.15)",display:"flex",gap:8,alignItems:"center"}}>
          <span>📤 {qCount} change{qCount!==1?"s":""} pending sync</span>
          <button onClick={flush} disabled={flushing} style={{background:"#D97706",color:"#fff",border:"none",borderRadius:10,padding:"2px 8px",cursor:"pointer",fontSize:9,fontWeight:700}}>
            {flushing?"Syncing...":"Sync Now"}
          </button>
        </div>
      )}
      {msg && <div style={{background:"#D1FAE5",color:"#065F46",padding:"4px 12px",borderRadius:16,fontSize:10,fontWeight:600}}>{msg}</div>}
      <div style={{background:cfg.bg,color:cfg.color,padding:"5px 12px",borderRadius:16,fontSize:10,fontWeight:600,boxShadow:"0 2px 8px rgba(0,0,0,0.15)"}}>
        {cfg.text}
      </div>
    </div>
  );
}



// ═══════════════════════════════════════════════════════════
// ASSANUSIYYAH GROUP OF SCHOOLS — COMPLETE SIS v3.0
// PMB 2002, Oke Yidi, Ipetumodu Road, Odeomu, Osun State
// Modules: Dashboard · Students · Attendance · Fees · Results
//          Staff · Timetable · Messages · Welfare · Settings
// ═══════════════════════════════════════════════════════════

const SCHOOL_LOGO = "";
// ─── LOGO CONTEXT ─────────────────────────────────────
// Logo is stored in settings.schoolLogo at runtime (uploaded by root admin)
// All components access it via this context — no prop drilling needed
const LogoContext = createContext("");
function useLogoSrc(){ return useContext(LogoContext); }

// Tracks whether the viewport is phone-width, so the app shell can switch
// the sidebar from a permanent 240px column to an off-canvas drawer —
// without this, a fixed-width sidebar plus full desktop content forces
// horizontal overflow on a phone in portrait mode.
function useIsMobile(){
  const [isMobile,setIsMobile]=useState(typeof window!=="undefined"&&window.innerWidth<=768);
  useEffect(function(){
    function onResize(){ setIsMobile(window.innerWidth<=768); }
    window.addEventListener("resize", onResize);
    return function(){ window.removeEventListener("resize", onResize); };
  },[]);
  return isMobile;
}

// SchoolCalendarWidget: live clock + countdown to the next school-calendar event.
// Shared between the staff dashboard and the Parent Portal home tab.
function SchoolCalendarWidget({settings}){
  var _now = useState(new Date()); var now = _now[0]; var setNow = _now[1];
  useEffect(function(){
    var iv = setInterval(function(){ setNow(new Date()); }, 1000);
    return function(){ clearInterval(iv); };
  },[]);

  var events = (settings.calendarEvents||[]).filter(function(e){ return e.date >= today(); }).sort(function(a,b){ return a.date.localeCompare(b.date); });
  var next = events[0];
  var daysLeft = next ? Math.ceil((new Date(next.date) - new Date(today())) / 86400000) : null;

  var timeStr = now.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});
  var dateStr = now.toLocaleDateString([], {weekday:"long", year:"numeric", month:"long", day:"numeric"});

  var TYPE_COLOR = {Academic:"#1D4ED8", Exam:"#DC2626", Holiday:"#059669", Event:"#D97706", Others:"#6B7280"};

  return(
    <div style={{background:"linear-gradient(120deg,#230E6A,#3D2496)",borderRadius:12,padding:"16px 20px",marginBottom:16,color:"#fff",display:"flex",flexWrap:"wrap",gap:16,alignItems:"center",justifyContent:"space-between"}}>
      <div>
        <div style={{fontSize:22,fontWeight:900,fontVariantNumeric:"tabular-nums",color:"#F0C060"}}>{timeStr}</div>
        <div style={{fontSize:11,opacity:0.85,marginTop:2}}>{dateStr}</div>
        <div style={{fontSize:11,opacity:0.7,marginTop:2}}>{CURRENT_SESSION} · {CURRENT_TERM}</div>
      </div>
      {next ? (
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11,opacity:0.8}}>Next on the school calendar</div>
          <div style={{fontSize:14,fontWeight:800,marginTop:2}}>{next.title}</div>
          <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",marginTop:4,gap:6}}>
            <span style={{background:TYPE_COLOR[next.type]||"#6B7280",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700}}>{next.type}</span>
            <span style={{fontSize:12,fontWeight:700,color:"#F0C060"}}>{daysLeft===0?"Today":daysLeft===1?"Tomorrow":"in "+daysLeft+" days"}</span>
          </div>
          <div style={{fontSize:10,opacity:0.6,marginTop:2}}>{formatDate(next.date)}</div>
        </div>
      ) : (
        <div style={{fontSize:11,opacity:0.7}}>No upcoming calendar events.</div>
      )}
    </div>
  );
}

// SchoolLogoImg: renders the logo from context, or an "AS" badge if no logo uploaded yet
function SchoolLogoImg({size=44, style={}, bg="rgba(255,255,255,0.9)", round=false}){
  const logo = useLogoSrc();
  if(logo){
    return <img src={logo} alt="Logo" style={{width:size,height:size,objectFit:"contain",flexShrink:0,...style}}/>;
  }
  return(
    <div style={{width:size,height:size,background:bg,borderRadius:round?"50%":6,
      display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,...style}}>
      <span style={{fontSize:size*0.28,fontWeight:900,color:"#230E6A",textAlign:"center",lineHeight:1}}>AS</span>
    </div>
  );
}
const SCHOOL_NAME = "ASSANUSIYYAH GROUP OF SCHOOLS";
const SCHOOL_ADDRESS = "PMB 2002, Oke Yidi, Ipetumodu Road, Odeomu, Osun State";
const SCHOOL_MOTTO = "Moral, Education & Excellence";

// ─── DESIGN TOKENS ────────────────────────────────────────
const C = {
  primary:"#230E6A", primaryLight:"#3D2496", primaryDark:"#160946",
  gold:"#6B491B", goldLight:"#A67C3D",
  ivory:"#F9F6EF", white:"#FFFFFF", text:"#1A1A1A", textMuted:"#6B7280",
  border:"#D9CBB0", danger:"#B91C1C", dangerLight:"#FEE2E2",
  success:"#166534", successLight:"#DCFCE7",
  warning:"#92400E", warningLight:"#FEF3C7",
  sidebarBg:"#160946", blue:"#1D4ED8", blueLight:"#DBEAFE",
  purple:"#6D28D9", orange:"#EA580C", orangeLight:"#FFEDD5",
};

// ─── CONSTANTS ────────────────────────────────────────────
const CLASSES = ["JSS1","JSS2","JSS3","SS1","SS2","SS3"];
const ARMS = ["A","B","C"];
const TERMS = ["First Term","Second Term","Third Term"];
const SESSIONS = ["2022/2023","2023/2024","2024/2025","2025/2026"];
const CURRENT_SESSION = "2025/2026";
const CURRENT_TERM = "Third Term";
const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday"];
const PERIODS = [1,2,3,4,5,6,7,8];

const SUBJECTS_JNR = ["English Language","Mathematics","Basic Science","Basic Technology","Social Studies","Civic Education","Agricultural Science","CRS / Islamic Studies","Business Studies","French","PHE","Fine Arts","Music","Computer Studies"];
const SUBJECTS_SNR = ["English Language","Mathematics","Further Mathematics","Physics","Chemistry","Biology","Agricultural Science","Economics","Government","Commerce","Accounting","Civic Education","Geography","CRS / Islamic Studies","Literature in English","Computer Studies","PHE"];
function getSubjects(cls) { return ["JSS1","JSS2","JSS3"].includes(cls) ? SUBJECTS_JNR : SUBJECTS_SNR; }

function genId() { return Math.random().toString(36).substr(2,9).toUpperCase(); }
function admNo(yr, seq) { return `ASS/${yr}/${String(seq).padStart(4,"0")}`; }
function today() { return new Date().toISOString().split("T")[0]; }
function formatDate(d) { return d ? new Date(d).toLocaleDateString("en-NG",{day:"2-digit",month:"short",year:"numeric"}) : "—"; }
// ─── SMS STUB ─────────────────────────────────────────────
// Replace sendSMS() with real Termii/Twilio API call when backend is ready
// ══════════════════════════════════════════════════════
// TERMII SMS — calls our secure /api/sms proxy.
// Termii key is on the server. Never in the browser.
// ══════════════════════════════════════════════════════

function formatNGPhone(phone){
  var p = String(phone||"").replace(/\D/g,"");
  if(p.startsWith("234")) return "+"+p;
  if(p.startsWith("0")&&p.length===11) return "+234"+p.slice(1);
  if(p.length===10) return "+234"+p;
  return "+"+p;
}

async function sendSMS(phone, message, label){
  var lbl = label||"SMS";
  var formatted = formatNGPhone(phone);
  console.log("[SMS→"+formatted+"] "+lbl+": "+message.slice(0,60)+"...");
  try {
    var res = await fetch("/api/sms", {
      method:"POST",
      headers: authFetchHeaders(),
      body: JSON.stringify({to:formatted, message, label:lbl})
    });
    var data = await res.json();
    if(data.success){ console.log("[SMS] Delivered to "+formatted); return {success:true}; }
    console.warn("[SMS] Error:", data.error);
    return {success:false, error:data.error};
  } catch(e){
    console.error("[SMS] Error:", e.message);
    return {success:false, error:e.message};
  }
}

async function sendBulkSMS(contacts, message, label){
  if(!contacts||!contacts.length) return {success:false,count:0};
  var results = await Promise.all(
    contacts.map(function(c){
      return sendSMS(c.phone, message.replace("{name}",c.name||"Parent"), label);
    })
  );
  var sent = results.filter(function(r){return r.success;}).length;
  return {success:true, count:sent, total:results.length};
}

const SMS_TEMPLATES = {
  feeReceipt:   function(name,amount,balance){ return "Dear Parent of "+name+", payment of N"+amount+" received for "+CURRENT_TERM+" "+CURRENT_SESSION+". Balance: N"+balance+". Thank you. - "+SCHOOL_NAME; },
  feeReminder:  function(name,amount){ return "Dear Parent of "+name+", your ward has an outstanding fee balance of N"+amount+" for "+CURRENT_TERM+". Kindly pay to avoid disruption. - "+SCHOOL_NAME; },
  absenceAlert: function(name,date){ return "Dear Parent, "+name+" was absent from school on "+date+". Please contact us if this was unplanned. - "+SCHOOL_NAME; },
  resultReady:  function(name,term){ return "Dear Parent of "+name+", "+term+" results are now available. Log in to the school portal to view. - "+SCHOOL_NAME; },
  birthday:     function(name){ return "Happy Birthday "+name+"! Wishing you a wonderful day filled with joy and success. From all of us at "+SCHOOL_NAME+"."; },
  announcement: function(msg){ return msg+" - "+SCHOOL_NAME; },
  clearance:    function(name){ return "Dear Parent of "+name+", all fees for "+CURRENT_TERM+" "+CURRENT_SESSION+" are fully paid. Thank you for your prompt payment. - "+SCHOOL_NAME; },
};

async function notifyResultsPublished(students,term){
  var contacts = students.filter(function(s){return s.active&&s.parentPhone;})
    .map(function(s){return {phone:s.parentPhone,name:s.firstname+" "+s.surname};});
  return sendBulkSMS(contacts, SMS_TEMPLATES.resultReady("{name}",term||CURRENT_TERM), "Results Published");
}

// ─── SEED DATA ────────────────────────────────────────────
const SEED_STUDENTS = [
  {id:"S001",admissionNo:"ASS/2022/0001",surname:"Adebayo",firstname:"Fatimah",middlename:"Aduke",dob:"2010-03-15",gender:"Female",class:"JSS3",arm:"A",entryClass:"JSS1",entrySession:"2022/2023",parentName:"Alhaji Adebayo Rasheed",parentPhone:"08012345678",parentEmail:"rasheed@gmail.com",address:"12 Odeomu Road, Osogbo",religion:"Islam",bloodGroup:"O+",genotype:"AA",boardingType:"Day",phone:"08012345678",passport:"",active:true},
  {id:"S002",admissionNo:"ASS/2022/0002",surname:"Okonkwo",firstname:"Chukwuemeka",middlename:"Daniel",dob:"2009-11-22",gender:"Male",class:"SS1",arm:"B",entryClass:"JSS1",entrySession:"2022/2023",parentName:"Mr. Okonkwo Paul",parentPhone:"08098765432",parentEmail:"",address:"7 Unity Street, Osogbo",religion:"Christianity",bloodGroup:"A+",genotype:"AS",boardingType:"Boarder",phone:"08098765432",passport:"",active:true},
  {id:"S003",admissionNo:"ASS/2023/0001",surname:"Lawal",firstname:"Khadijah",middlename:"Bisi",dob:"2011-07-08",gender:"Female",class:"JSS2",arm:"A",entryClass:"JSS2",entrySession:"2023/2024",parentName:"Alhaja Lawal Aminat",parentPhone:"07065432198",parentEmail:"",address:"3 Ilesha Road, Odeomu",religion:"Islam",bloodGroup:"B+",genotype:"AA",boardingType:"Day",phone:"07065432198",passport:"",active:true},
  {id:"S004",admissionNo:"ASS/2022/0003",surname:"Fashola",firstname:"Tunde",middlename:"",dob:"2009-05-30",gender:"Male",class:"SS1",arm:"A",entryClass:"JSS1",entrySession:"2022/2023",parentName:"Mr. Fashola Segun",parentPhone:"08023456789",parentEmail:"fashola@yahoo.com",address:"21 Gbongan Road, Osogbo",religion:"Christianity",bloodGroup:"O-",genotype:"SS",boardingType:"Day",phone:"08023456789",passport:"",active:true},
  {id:"S005",admissionNo:"ASS/2023/0002",surname:"Bello",firstname:"Abdulrahman",middlename:"Gbolahan",dob:"2010-09-14",gender:"Male",class:"JSS2",arm:"B",entryClass:"JSS2",entrySession:"2023/2024",parentName:"Alhaji Bello Muftau",parentPhone:"08135678901",parentEmail:"",address:"15 Oba Ile, Osogbo",religion:"Islam",bloodGroup:"A-",genotype:"AC",boardingType:"Boarder",phone:"08135678901",passport:"",active:true},
  {id:"S006",admissionNo:"ASS/2022/0004",surname:"Afolabi",firstname:"Grace",middlename:"Oluwakemi",dob:"2009-12-01",gender:"Female",class:"SS1",arm:"A",entryClass:"JSS1",entrySession:"2022/2023",parentName:"Mrs. Afolabi Janet",parentPhone:"08056789012",parentEmail:"",address:"9 Sekona Rd, Osogbo",religion:"Christianity",bloodGroup:"B-",genotype:"AA",boardingType:"Day",phone:"08056789012",passport:"",active:true},
];

const SEED_RESULTS = [
  {studentId:"S001",session:"2025/2026",term:"Third Term",class:"JSS3",subject:"English Language",ca1:17,ca2:16,exam:52,total:85},
  {studentId:"S001",session:"2025/2026",term:"Third Term",class:"JSS3",subject:"Mathematics",ca1:19,ca2:18,exam:56,total:93},
  {studentId:"S001",session:"2025/2026",term:"Third Term",class:"JSS3",subject:"Basic Science",ca1:18,ca2:17,exam:54,total:89},
  {studentId:"S001",session:"2025/2026",term:"Third Term",class:"JSS3",subject:"CRS / Islamic Studies",ca1:20,ca2:19,exam:58,total:97},
  {studentId:"S001",session:"2025/2026",term:"First Term",class:"JSS3",subject:"English Language",ca1:16,ca2:15,exam:50,total:81},
  {studentId:"S001",session:"2025/2026",term:"First Term",class:"JSS3",subject:"Mathematics",ca1:18,ca2:17,exam:54,total:89},
  {studentId:"S001",session:"2025/2026",term:"Second Term",class:"JSS3",subject:"English Language",ca1:17,ca2:16,exam:51,total:84},
  {studentId:"S001",session:"2025/2026",term:"Second Term",class:"JSS3",subject:"Mathematics",ca1:19,ca2:18,exam:55,total:92},
  {studentId:"S002",session:"2025/2026",term:"Third Term",class:"SS1",subject:"English Language",ca1:11,ca2:12,exam:35,total:58},
  {studentId:"S002",session:"2025/2026",term:"Third Term",class:"SS1",subject:"Mathematics",ca1:9,ca2:10,exam:28,total:47},
  {studentId:"S002",session:"2025/2026",term:"Third Term",class:"SS1",subject:"Physics",ca1:12,ca2:13,exam:38,total:63},
  {studentId:"S002",session:"2025/2026",term:"First Term",class:"SS1",subject:"English Language",ca1:10,ca2:11,exam:32,total:53},
  {studentId:"S002",session:"2025/2026",term:"First Term",class:"SS1",subject:"Mathematics",ca1:8,ca2:9,exam:25,total:42},
  {studentId:"S003",session:"2025/2026",term:"Third Term",class:"JSS2",subject:"English Language",ca1:16,ca2:15,exam:50,total:81},
  {studentId:"S003",session:"2025/2026",term:"Third Term",class:"JSS2",subject:"Mathematics",ca1:18,ca2:17,exam:55,total:90},
  {studentId:"S004",session:"2025/2026",term:"Third Term",class:"SS1",subject:"English Language",ca1:15,ca2:14,exam:48,total:77},
  {studentId:"S004",session:"2025/2026",term:"Third Term",class:"SS1",subject:"Mathematics",ca1:17,ca2:16,exam:52,total:85},
  {studentId:"S004",session:"2025/2026",term:"Third Term",class:"SS1",subject:"Physics",ca1:18,ca2:17,exam:54,total:89},
  {studentId:"S005",session:"2025/2026",term:"Third Term",class:"JSS2",subject:"English Language",ca1:13,ca2:12,exam:40,total:65},
  {studentId:"S005",session:"2025/2026",term:"Third Term",class:"JSS2",subject:"Mathematics",ca1:11,ca2:10,exam:32,total:53},
  {studentId:"S006",session:"2025/2026",term:"Third Term",class:"SS1",subject:"English Language",ca1:18,ca2:17,exam:55,total:90},
  {studentId:"S006",session:"2025/2026",term:"Third Term",class:"SS1",subject:"Mathematics",ca1:16,ca2:15,exam:50,total:81},
  {studentId:"S006",session:"2025/2026",term:"Third Term",class:"SS1",subject:"Economics",ca1:19,ca2:18,exam:57,total:94},
];

const SEED_ATTENDANCE = [
  {id:"A001",studentId:"S001",date:"2026-06-23",session:CURRENT_SESSION,term:CURRENT_TERM,class:"JSS3",present:true},
  {id:"A002",studentId:"S001",date:"2026-06-24",session:CURRENT_SESSION,term:CURRENT_TERM,class:"JSS3",present:true},
  {id:"A003",studentId:"S001",date:"2026-06-25",session:CURRENT_SESSION,term:CURRENT_TERM,class:"JSS3",present:false},
  {id:"A004",studentId:"S002",date:"2026-06-23",session:CURRENT_SESSION,term:CURRENT_TERM,class:"SS1",present:true},
  {id:"A005",studentId:"S002",date:"2026-06-24",session:CURRENT_SESSION,term:CURRENT_TERM,class:"SS1",present:false},
  {id:"A006",studentId:"S002",date:"2026-06-25",session:CURRENT_SESSION,term:CURRENT_TERM,class:"SS1",present:false},
  {id:"A007",studentId:"S003",date:"2026-06-23",session:CURRENT_SESSION,term:CURRENT_TERM,class:"JSS2",present:true},
  {id:"A008",studentId:"S003",date:"2026-06-24",session:CURRENT_SESSION,term:CURRENT_TERM,class:"JSS2",present:true},
];

const SEED_FEES = [
  {id:"F001",studentId:"S001",session:CURRENT_SESSION,term:CURRENT_TERM,feeType:"School Fees",amount:15000,amountPaid:15000,datePaid:"2026-01-15",status:"Paid",receipt:"RCP001"},
  {id:"F002",studentId:"S002",session:CURRENT_SESSION,term:CURRENT_TERM,feeType:"School Fees",amount:15000,amountPaid:7500,datePaid:"2026-01-20",status:"Part-Payment",receipt:"RCP002"},
  {id:"F003",studentId:"S003",session:CURRENT_SESSION,term:CURRENT_TERM,feeType:"School Fees",amount:15000,amountPaid:0,datePaid:"",status:"Unpaid",receipt:""},
  {id:"F004",studentId:"S004",session:CURRENT_SESSION,term:CURRENT_TERM,feeType:"School Fees",amount:15000,amountPaid:15000,datePaid:"2026-01-10",status:"Paid",receipt:"RCP004"},
  {id:"F005",studentId:"S005",session:CURRENT_SESSION,term:CURRENT_TERM,feeType:"School Fees",amount:15000,amountPaid:5000,datePaid:"2026-02-01",status:"Part-Payment",receipt:"RCP005"},
  {id:"F006",studentId:"S006",session:CURRENT_SESSION,term:CURRENT_TERM,feeType:"School Fees",amount:15000,amountPaid:15000,datePaid:"2026-01-08",status:"Paid",receipt:"RCP006"},
];

const SEED_EXPENDITURE = [
  {id:"E001",date:"2026-01-10",amount:25000,category:"Maintenance",reason:"Roof repair — Block A",recordedBy:"Admin"},
  {id:"E002",date:"2026-02-05",amount:8500,category:"Stationery",reason:"Exam question papers printing",recordedBy:"Admin"},
  {id:"E003",date:"2026-03-15",amount:15000,category:"Utilities",reason:"PHCN prepaid electricity",recordedBy:"Bursar"},
];

const SEED_STAFF = [
  {id:"T001",surname:"Adekunle",firstname:"Yemi",middlename:"",dob:"1985-06-12",gender:"Male",phone:"08011112222",address:"14 Staff Quarters, Odeomu",qualification:"B.Ed Mathematics",nextOfKin:"Adekunle Bisi",nextOfKinPhone:"08033334444",subjects:["Mathematics","Further Mathematics"],classes:["SS1","SS2"],periodsPerWeek:6,role:"Teacher",active:true,password:"",passport:""},
  {id:"T002",surname:"Oduola",firstname:"Rashidat",middlename:"Amina",dob:"1990-09-22",gender:"Female",phone:"08055556666",address:"7 Igbore St, Osogbo",qualification:"M.Ed English",nextOfKin:"Oduola Kamil",nextOfKinPhone:"08077778888",subjects:["English Language","Literature in English"],classes:["JSS1","JSS2","JSS3"],periodsPerWeek:8,role:"Teacher",active:true,password:""},
  {id:"T003",surname:"Ibrahim",firstname:"Sulaiman",middlename:"",dob:"1978-01-30",gender:"Male",phone:"08099990000",address:"2 Ilesha Rd, Odeomu",qualification:"B.Sc Physics",nextOfKin:"Ibrahim Hafsat",nextOfKinPhone:"08011119999",subjects:["Physics","Basic Science"],classes:["SS1","SS2","SS3","JSS3"],periodsPerWeek:10,role:"Teacher",active:true,password:""},
];

const SEED_TIMETABLE = [];

const SEED_MESSAGES = [
  {id:"MSG001",title:"Fee Payment Reminder",body:"Dear Parent of {name}, this is to remind you that your ward's school fee of ₦{balance} is still outstanding for {term} {session}. Please pay immediately. — Assanusiyyah Group of Schools",type:"Fee Reminder",createdAt:"2026-01-01"},
  {id:"MSG002",title:"Fee Receipt",body:"Dear Parent of {name}, payment of ₦{amount} received for {term} {session} school fees. Receipt No: {receipt}. Thank you. — Assanusiyyah Schools",type:"Receipt",createdAt:"2026-01-01"},
  {id:"MSG003",title:"Fee Clearance",body:"Dear Parent of {name}, we confirm that {name} has fully paid all fees for {term} {session}. Thank you. — Assanusiyyah Schools",type:"Clearance",createdAt:"2026-01-01"},
  {id:"MSG004",title:"Absence Alert",body:"Dear Parent of {name}, your ward {name} was absent from school on {date}. Please ensure regular attendance. — Assanusiyyah Schools",type:"Absence",createdAt:"2026-01-01"},
  {id:"MSG005",title:"Birthday Greeting",body:"Happy Birthday {name}! Wishing you many more years of excellence. — Assanusiyyah Group of Schools",type:"Birthday",createdAt:"2026-01-01"},
];

const SEED_CONDUCT = [
  {id:"C001",studentId:"S002",session:CURRENT_SESSION,term:CURRENT_TERM,type:"Lateness",description:"Late 5 times this term",date:"2026-04-10",recordedBy:"Form Teacher"},
  {id:"C003",studentId:"S001",session:CURRENT_SESSION,term:CURRENT_TERM,type:"Commendation",description:"Best student in Islamic Studies",date:"2026-05-01",recordedBy:"Subject Teacher"},
];

const SEED_PROMOTIONS = [
  {studentId:"S001",fromSession:"2022/2023",fromClass:"JSS1",toClass:"JSS2",status:"Promoted"},
  {studentId:"S002",fromSession:"2024/2025",fromClass:"JSS3",toClass:"SS1",status:"Promoted"},
];

const SEED_DIARY = [
  {id:"D001",date:"2026-06-23",time:"08:00",event:"Morning assembly held — Principal addressed students on examination conduct",category:"General",recordedBy:"Admin",session:CURRENT_SESSION,term:CURRENT_TERM},
  {id:"D002",date:"2026-06-23",time:"10:30",event:"Inter-house sports practice for JSS classes",category:"Sports",recordedBy:"Admin",session:CURRENT_SESSION,term:CURRENT_TERM},
  {id:"D003",date:"2026-06-24",time:"09:00",event:"PTA representatives visited to discuss third term examination timetable",category:"Visitors",recordedBy:"Admin",session:CURRENT_SESSION,term:CURRENT_TERM},
  {id:"D004",date:"2026-06-24",time:"13:00",event:"Minor disagreement between two SS1 students resolved by Vice Principal",category:"Discipline",recordedBy:"Admin",session:CURRENT_SESSION,term:CURRENT_TERM},
  {id:"D005",date:"2026-06-25",time:"08:30",event:"New set of textbooks delivered for JSS3 Basic Science",category:"Logistics",recordedBy:"Admin",session:CURRENT_SESSION,term:CURRENT_TERM},
];

const SEED_ELIBRARY = [
  {id:"BK001",title:"New General Mathematics SSS 1",author:"M.F. Macrae et al.",subject:"Mathematics",category:"Textbook",level:"SS1",type:"link",url:"https://www.academia.edu/",description:"Comprehensive SS1 Mathematics covering algebra, geometry and statistics.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK002",title:"New General Mathematics SSS 2",author:"M.F. Macrae et al.",subject:"Mathematics",category:"Textbook",level:"SS2",type:"link",url:"https://www.academia.edu/",description:"SS2 Mathematics covering calculus, statistics and further algebra.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK003",title:"New General Mathematics SSS 3",author:"M.F. Macrae et al.",subject:"Mathematics",category:"Textbook",level:"SS3",type:"link",url:"https://www.academia.edu/",description:"SS3 Mathematics — WAEC/NECO exam preparation with past questions.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK004",title:"Oral English for Schools and Colleges",author:"Sam Onuigbo",subject:"English Language",category:"Textbook",level:"All",type:"link",url:"https://www.academia.edu/",description:"Practical guide to oral English skills for Nigerian secondary school students.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK005",title:"Countdown to WASSCE English Language",author:"Olatunde Ogunmodede",subject:"English Language",category:"Past Questions",level:"SS3",type:"link",url:"https://www.academia.edu/",description:"Comprehensive WASSCE English preparation covering all sections.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK006",title:"Biology for Senior Secondary Schools",author:"Idodo-Umeh",subject:"Biology",category:"Textbook",level:"SS",type:"link",url:"https://www.academia.edu/",description:"Covers all WAEC Biology topics — ecology, genetics, human physiology.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK007",title:"Chemistry for Senior Secondary Schools 1",author:"Osei Yaw Ababio",subject:"Chemistry",category:"Textbook",level:"SS1",type:"link",url:"https://www.academia.edu/",description:"Foundation Chemistry covering atomic structure, bonding and reactions.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK008",title:"Physics for Senior Secondary Schools",author:"Abbott",subject:"Physics",category:"Textbook",level:"SS",type:"link",url:"https://www.academia.edu/",description:"Complete Physics for WAEC/NECO covering mechanics, waves, electricity.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK009",title:"Economics for Senior Secondary Schools",author:"E.U. Essien",subject:"Economics",category:"Textbook",level:"SS",type:"link",url:"https://www.academia.edu/",description:"Covers micro and macroeconomics, Nigerian economy and international trade.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK010",title:"Government for Senior Secondary Schools",author:"Oyeleye",subject:"Government",category:"Textbook",level:"SS",type:"link",url:"https://www.academia.edu/",description:"Nigerian government and politics, constitution and comparative government.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK011",title:"WAEC Past Questions — Mathematics 2019-2024",author:"WAEC",subject:"Mathematics",category:"Past Questions",level:"SS3",type:"link",url:"https://www.waecdirect.org/",description:"Six years of WAEC Mathematics questions with marking schemes. Essential for exam prep.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK012",title:"WAEC Past Questions — English Language 2019-2024",author:"WAEC",subject:"English Language",category:"Past Questions",level:"SS3",type:"link",url:"https://www.waecdirect.org/",description:"WAEC English past questions — comprehension, essay, oral and summary.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK013",title:"WAEC Past Questions — Biology 2019-2024",author:"WAEC",subject:"Biology",category:"Past Questions",level:"SS3",type:"link",url:"https://www.waecdirect.org/",description:"Six years of WAEC Biology with answers. Essential revision for final year students.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK014",title:"NECO Past Questions — Mathematics 2018-2023",author:"NECO",subject:"Mathematics",category:"Past Questions",level:"SS3",type:"link",url:"https://www.neco.gov.ng/",description:"NECO Mathematics past questions with detailed solutions.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK015",title:"Holy Quran — Arabic with English Translation",author:"Sahih International",subject:"Islamic Religious Studies",category:"Religious Text",level:"All",type:"link",url:"https://quran.com/",description:"Complete Quran with Arabic text and English translation. Open access for all.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK016",title:"40 Hadith Nawawi — Arabic & English",author:"Imam An-Nawawi",subject:"Islamic Religious Studies",category:"Religious Text",level:"All",type:"link",url:"https://sunnah.com/nawawi40",description:"The 40 famous hadith of Imam Nawawi with Arabic text and English explanation.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK017",title:"The Holy Bible (NIV)",author:"International Bible Society",subject:"Christian Religious Studies",category:"Religious Text",level:"All",type:"link",url:"https://www.bible.com/bible/111/GEN.1.NIV",description:"Complete NIV Bible for Christian Religious Studies students and staff.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK018",title:"Junior Secondary Mathematics JSS1",author:"MAN — Mathematical Association",subject:"Mathematics",category:"Textbook",level:"JSS1",type:"link",url:"https://www.academia.edu/",description:"JSS1 Mathematics — number systems, basic algebra, geometry and measurements.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK019",title:"Junior Secondary Mathematics JSS2",author:"MAN",subject:"Mathematics",category:"Textbook",level:"JSS2",type:"link",url:"https://www.academia.edu/",description:"JSS2 Mathematics — fractions, indices, graphs, plane geometry.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK020",title:"Junior Secondary Mathematics JSS3",author:"MAN",subject:"Mathematics",category:"Textbook",level:"JSS3",type:"link",url:"https://www.academia.edu/",description:"JSS3 Mathematics — trigonometry, statistics, simultaneous equations. BECE prep.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK021",title:"Basic Science JSS1-JSS3",author:"Stan Achimugu",subject:"Basic Science",category:"Textbook",level:"JSS",type:"link",url:"https://www.academia.edu/",description:"Complete Basic Science for junior secondary covering biology, physics and chemistry foundations.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK022",title:"Civic Education for Senior Secondary Schools",author:"Okoye",subject:"Civic Education",category:"Textbook",level:"SS",type:"link",url:"https://www.academia.edu/",description:"Citizenship, democracy, human rights and Nigerian governance.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK023",title:"Agricultural Science for Senior Secondary Schools",author:"Akinsanmi",subject:"Agricultural Science",category:"Textbook",level:"SS",type:"link",url:"https://www.academia.edu/",description:"Crop production, animal husbandry, farm management and agricultural economics.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK024",title:"Computer Studies for JSS",author:"Fagbola",subject:"Computer Science",category:"Textbook",level:"JSS",type:"link",url:"https://www.academia.edu/",description:"Introduction to computing, Microsoft Office, internet safety and programming basics.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK025",title:"Khan Academy — Free Online Lessons",author:"Khan Academy",subject:"Mathematics",category:"Video Link",level:"All",type:"link",url:"https://www.khanacademy.org/",description:"Free video lessons on Mathematics, Science, Economics and more. Works on any device.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK026",title:"CK-12 — Free Textbooks & Exercises",author:"CK-12 Foundation",subject:"Basic Science",category:"Reference",level:"All",type:"link",url:"https://www.ck12.org/",description:"Free digital textbooks on Science and Mathematics. Includes exercises and simulations.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK027",title:"WAEC Direct — Official Results & Resources",author:"WAEC",subject:"General",category:"Reference",level:"SS3",type:"link",url:"https://www.waecdirect.org/",description:"Official WAEC portal for checking results, past questions and examination guides.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK028",title:"Encyclopaedia Britannica — Student Edition",author:"Britannica",subject:"General",category:"Reference",level:"All",type:"link",url:"https://www.britannica.com/",description:"Trusted encyclopaedia for research on any topic across all subjects.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK029",title:"Literature — Things Fall Apart",author:"Chinua Achebe",subject:"Literature in English",category:"Novel / Literature",level:"SS",type:"link",url:"https://www.academia.edu/",description:"Chinua Achebe's classic Nigerian novel — required text for WAEC Literature in English.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
  {id:"BK030",title:"Literature — The Trials of Brother Jero",author:"Wole Soyinka",subject:"Literature in English",category:"Novel / Literature",level:"SS",type:"link",url:"https://www.academia.edu/",description:"Wole Soyinka's satirical play. Key text for senior secondary Literature students.",uploadedBy:"Admin",uploadedAt:"2026-01-10",downloads:0,views:0},
];

const SEED_CLINIC = [
  {id:"CL001",studentId:"S001",admissionNo:"ASS/2022/0001",studentName:"Fatimah Adebayo",class:"JSS3A",date:"2026-06-20",time:"10:30",presentingCondition:"Headache and mild fever",vitalSigns:{temperature:"37.8°C",pulse:"82bpm",bp:"110/70",weight:"45kg",height:"152cm"},diagnosis:"Mild febrile illness — likely viral",treatmentPlan:"Rest, hydration, paracetamol",medications:[{drug:"Paracetamol 500mg",dose:"1 tablet",frequency:"Every 6 hours",duration:"3 days"}],nurseName:"Nurse Amina",disposition:"Returned to class",followUp:"2026-06-23",notes:"Advised to report if symptoms worsen. Parents notified."},
];

const SEED_ADMISSIONS = [];

const SEED_EXAMS = [];

const SEED_GALLERY = [];

// Fallback grading scale, used whenever settings.resultConfig.gradeScale is
// missing/empty (old persisted settings, or a fresh install). Root admin can
// override this from Settings → Result Sheet Config.
const DEFAULT_GRADE_SCALE = [
  {grade:"A1",min:75,remark:"Excellent",band:"A"},
  {grade:"B2",min:70,remark:"Very Good",band:"B"},
  {grade:"B3",min:65,remark:"Good",band:"B"},
  {grade:"C4",min:60,remark:"Credit",band:"C"},
  {grade:"C5",min:55,remark:"Credit",band:"C"},
  {grade:"C6",min:50,remark:"Credit",band:"C"},
  {grade:"D7",min:45,remark:"Pass",band:"D"},
  {grade:"E8",min:40,remark:"Pass",band:"E"},
  {grade:"F9",min:0,remark:"Fail",band:"F"},
];

const DEFAULT_RESULT_CONFIG = {
  ca1Max: 20, ca2Max: 20, examMax: 60,
  passMark: 40,
  gradeScale: DEFAULT_GRADE_SCALE,
  showAffectiveTraits: true,
  showPsychomotorSkills: true,
  showPosition: true,
  showClassAverage: true,
  showComments: true,
};

const SEED_SETTINGS = {
  adminPhone: "08012345678",
  schoolLogo: "",
  schoolStamp: "",
  signature: "",
  calendarEvents: [
    {id:"CAL001",title:"Third Term Begins",date:"2026-01-08",type:"Academic"},
    {id:"CAL002",title:"Mid-Term Break",date:"2026-03-10",type:"Holiday"},
    {id:"CAL003",title:"Third Term Exams",date:"2026-05-20",type:"Exam"},
    {id:"CAL004",title:"Closing Day",date:"2026-06-30",type:"Academic"},
  ],
  extraClasses: [],
  extraSubjects: [],
  resultConfig: DEFAULT_RESULT_CONFIG,
  resultsPublished: {},
};

// Merges a possibly-stale/partial settings.resultConfig with defaults so old
// persisted settings rows (missing new fields) never crash a report card.
function getResultConfig(settings){
  var rc = (settings && settings.resultConfig) || {};
  return {
    ca1Max: rc.ca1Max || DEFAULT_RESULT_CONFIG.ca1Max,
    ca2Max: rc.ca2Max || DEFAULT_RESULT_CONFIG.ca2Max,
    examMax: rc.examMax || DEFAULT_RESULT_CONFIG.examMax,
    passMark: (rc.passMark===0||rc.passMark) ? rc.passMark : DEFAULT_RESULT_CONFIG.passMark,
    gradeScale: (rc.gradeScale && rc.gradeScale.length) ? rc.gradeScale : DEFAULT_GRADE_SCALE,
    showAffectiveTraits: rc.showAffectiveTraits!==false,
    showPsychomotorSkills: rc.showPsychomotorSkills!==false,
    showPosition: rc.showPosition!==false,
    showClassAverage: rc.showClassAverage!==false,
    showComments: rc.showComments!==false,
  };
}

// Given a score and a (possibly custom) grade scale sorted by min descending,
// returns the matching {grade,remark,band}. Falls back to the last (lowest) band.
function getGrade(score, settings){
  var scale = settings ? getResultConfig(settings).gradeScale : DEFAULT_GRADE_SCALE;
  var sorted = scale.slice().sort(function(a,b){ return b.min-a.min; });
  for(var i=0;i<sorted.length;i++){ if(score>=sorted[i].min) return sorted[i]; }
  return sorted[sorted.length-1] || {grade:"F9",remark:"Fail",band:"F"};
}
// ══════════════════════════════════════════════════════
// ALL PAGES & THEIR REQUIRED PERMISSIONS
// ══════════════════════════════════════════════════════
const ALL_PAGES = [
  {id:"dashboard",label:"Dashboard",icon:"dashboard"},
  {id:"analytics",label:"Analytics",icon:"analytics"},
  {id:"students",label:"Students",icon:"students"},
  {id:"attendance",label:"Attendance",icon:"attendance"},
  {id:"results",label:"Results",icon:"results"},
  {id:"lessons",label:"Lesson Notes",icon:"subject"},
  {id:"studentportal",label:"Student Portal",icon:"welfare"},
  {id:"elibrary",label:"E-Library",icon:"elibrary"},
  {id:"fees",label:"Fees & Finance",icon:"fees"},
  {id:"clinic",label:"Clinic",icon:"clinic"},
  {id:"exams",label:"Exams",icon:"exams"},
  {id:"hostel",label:"Hostel & Kitchen",icon:"hostel"},
  {id:"staff",label:"Staff",icon:"staff"},
  {id:"timetable",label:"Timetable",icon:"timetable"},
  {id:"idcards",label:"ID Cards",icon:"idcard"},
  {id:"diary",label:"School Diary",icon:"diary"},
  {id:"payroll",label:"Payroll",icon:"fees"},
  {id:"calendar",label:"Period Planner",icon:"timetable"},
  {id:"alumni",label:"Alumni",icon:"students"},
  {id:"admissions",label:"Admissions",icon:"admissions"},
  {id:"gallery",label:"Gallery",icon:"gallery"},
  {id:"messages",label:"Messages",icon:"messages"},
  {id:"welfare",label:"Welfare",icon:"welfare"},
  {id:"counsellor",label:"Counsellor",icon:"counsellor"},
  {id:"settings",label:"Settings",icon:"settings"},
];

function userCanAccess(user, pageId){
  if(!user)return false;
  if(user.role==="root")return true;
  const perms=user.permissions||[];
  if(perms.includes("all"))return true;
  return perms.includes(pageId);
}

// ══════════════════════════════════════════════════════
// NAV CONFIG (sections for sidebar)
// ══════════════════════════════════════════════════════
const NAV = [
  {id:"dashboard",label:"Dashboard",icon:"dashboard",section:"OVERVIEW"},
  {id:"analytics",label:"Analytics",icon:"analytics",section:"OVERVIEW"},
  {id:"students",label:"Students",icon:"students",section:"ACADEMICS"},
  {id:"attendance",label:"Attendance",icon:"attendance",section:"ACADEMICS"},
  {id:"results",label:"Results",icon:"results",section:"ACADEMICS"},
  {id:"lessons",label:"Lesson Notes",icon:"subject",section:"LMS"},
  {id:"studentportal",label:"Student Portal",icon:"welfare",section:"LMS"},
  {id:"elibrary",label:"E-Library",icon:"elibrary",section:"LMS"},
  {id:"fees",label:"Fees & Finance",icon:"fees",section:"FINANCE"},
  {id:"clinic",label:"Clinic",icon:"clinic",section:"ACADEMICS"},
  {id:"exams",label:"Exams",icon:"exams",section:"ACADEMICS"},
  {id:"hostel",label:"Hostel & Kitchen",icon:"hostel",section:"ADMINISTRATION"},
  {id:"staff",label:"Staff",icon:"staff",section:"ADMINISTRATION"},
  {id:"timetable",label:"Timetable",icon:"timetable",section:"ADMINISTRATION"},
  {id:"idcards",label:"ID Cards",icon:"idcard",section:"ADMINISTRATION"},
  {id:"diary",label:"School Diary",icon:"diary",section:"ADMINISTRATION"},
  {id:"payroll",label:"Payroll",icon:"fees",section:"ADMINISTRATION"},
  {id:"calendar",label:"Period Planner",icon:"timetable",section:"ADMINISTRATION"},
  {id:"alumni",label:"Alumni",icon:"students",section:"ADMINISTRATION"},
  {id:"admissions",label:"Admissions",icon:"admissions",section:"ADMINISTRATION"},
  {id:"gallery",label:"Gallery",icon:"gallery",section:"COMMUNICATION"},
  {id:"messages",label:"Messages",icon:"messages",section:"COMMUNICATION"},
  {id:"welfare",label:"Welfare",icon:"welfare",section:"COMMUNICATION"},
  {id:"counsellor",label:"Counsellor",icon:"counsellor",section:"COMMUNICATION"},
  {id:"settings",label:"Settings",icon:"settings",section:"SYSTEM"},
];

const PAGE_TITLES = {
  dashboard:"Dashboard",analytics:"Student Analytics",elibrary:"E-Library",clinic:"School Clinic",counsellor:"School Counsellor",exams:"Exams & Assessment",payroll:"Payroll & Staff Finance",calendar:"Academic Period Planner",alumni:"Alumni Records",admissions:"Admissions Portal",students:"Student Records",attendance:"Attendance",results:"Results",
  lessons:"Lesson Notes",studentportal:"Student Portal",
  fees:"Fees & Finance",staff:"Staff Records",timetable:"School Timetable",idcards:"ID Cards",diary:"School Diary",
  messages:"Messages",welfare:"Welfare & Conduct",settings:"Settings & Administration",gallery:"School Gallery",
  hostel:"Hostel & Kitchen Management",
};

// Dashboard card colours per module
const MODULE_COLORS = {
  students:{bg:"#EFF6FF",accent:"#1D4ED8",emoji:"👨‍🎓"},
  attendance:{bg:"#F0FDF4",accent:"#166534",emoji:"📋"},
  results:{bg:"#F5F3FF",accent:"#6D28D9",emoji:"📊"},
  fees:{bg:"#FFFBEB",accent:"#6B491B",emoji:"💰"},
  staff:{bg:"#FFF7ED",accent:"#EA580C",emoji:"👩‍🏫"},
  timetable:{bg:"#ECFDF5",accent:"#0D9488",emoji:"🗓️"},
  messages:{bg:"#EFF6FF",accent:"#2563EB",emoji:"💬"},
  welfare:{bg:"#FDF4FF",accent:"#9333EA",emoji:"❤️"},
  settings:{bg:"#F1F5F9",accent:"#475569",emoji:"⚙️"},
  lessons:{bg:"#F0FDF4",accent:"#166534",emoji:"📝"},
  studentportal:{bg:"#EFF6FF",accent:"#1D4ED8",emoji:"🎓"},
  idcards:{bg:"#FDF4FF",accent:"#230E6A",emoji:"🪪"},
  diary:{bg:"#FFF7ED",accent:"#6B491B",emoji:"📔"},
  gallery:{bg:"#F5F3FB",accent:"#230E6A",emoji:"🖼️"},
  analytics:{bg:"#EFF6FF",accent:"#1D4ED8",emoji:"📊"},
  elibrary:{bg:"#F0FDF4",accent:"#059669",emoji:"📚"},
  clinic:{bg:"#FEF2F2",accent:"#DC2626",emoji:"🏥"},
  counsellor:{bg:"#F0FDF4",accent:"#059669",emoji:"💚"},
  exams:{bg:"#FFF7ED",accent:"#D97706",emoji:"📝"},
  payroll:{bg:"#F0FDF4",accent:"#059669",emoji:"💵"},
  calendar:{bg:"#EFF6FF",accent:"#1D4ED8",emoji:"📅"},
  alumni:{bg:"#FDF4FF",accent:"#7C3AED",emoji:"🎓"},
  admissions:{bg:"#EFF6FF",accent:"#1D4ED8",emoji:"📝"},
  hostel:{bg:"#FFF7ED",accent:"#B45309",emoji:"🏠"},
};

// ── Dashboard with clickable module cards ──────────────
function DashboardHome({students,results,fees,attendance,staff,settings,currentUser,onNavigate}){
  const active=students.filter(s=>s.active);
  const tb=fees.reduce((a,f)=>a+f.amount,0),tp=fees.reduce((a,f)=>a+f.amountPaid,0);
  const curR=results.filter(r=>r.session===CURRENT_SESSION&&r.term===CURRENT_TERM);
  const avg=curR.length?(curR.reduce((a,r)=>a+r.total,0)/curR.length).toFixed(1):"—";
  const mm_dd=today().slice(5);
  const bday_s=students.filter(s=>s.active&&s.dob&&s.dob.slice(5)===mm_dd);
  const bday_t=staff.filter(s=>s.active&&s.dob&&s.dob.slice(5)===mm_dd);

  // Pages this user can see (excluding dashboard itself)
  const accessibleModules=NAV.filter(n=>n.id!=="dashboard"&&userCanAccess(currentUser,n.id));

  // Financial figures are sensitive — only show them to users with access
  // to the Fees module itself (Bursar, School Administrator, root).
  const canSeeFees = userCanAccess(currentUser,"fees");
  const quickStats=[
    {l:"Total Students",v:active.length},
    {l:"Day Students",v:active.filter(s=>s.boardingType==="Day").length},
    {l:"Boarders",v:active.filter(s=>s.boardingType==="Boarder").length},
    {l:"Staff Members",v:staff.filter(s=>s.active).length},
    {l:"School Average",v:avg+"%"},
    ...(canSeeFees?[
      {l:"Fees Collected",v:`₦${tp.toLocaleString()}`},
      {l:"Outstanding",v:`₦${(tb-tp).toLocaleString()}`},
    ]:[]),
    {l:"Result Entries",v:curR.length},
  ];

  return(<div>
    {/* Welcome banner */}
    <div style={{background:`linear-gradient(135deg,${C.primaryDark},${C.primaryLight})`,borderRadius:12,padding:"20px 24px",marginBottom:20,...S.row,gap:16,flexWrap:"wrap"}}>
      <SchoolLogoImg size={60}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:18,fontWeight:800,color:C.goldLight,overflowWrap:"break-word"}}>{SCHOOL_NAME}</div>
        <div style={{fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:2}}>{SCHOOL_ADDRESS}</div>
        <div style={{fontSize:11,color:C.goldLight,marginTop:4,fontStyle:"italic"}}>{SCHOOL_MOTTO}</div>
      </div>
      <div style={{textAlign:"right",flexShrink:0}}>
        <div style={{color:"rgba(255,255,255,0.6)",fontSize:10}}>Welcome,</div>
        <div style={{color:C.goldLight,fontWeight:700,fontSize:13}}>{currentUser.name}</div>
        <div style={{...S.badge(currentUser.role==="root"?"gold":"blue"),marginTop:4,fontSize:10}}>{currentUser.role==="root"?"🔑 Root Admin":currentUser.role}</div>
        <div style={{color:"rgba(255,255,255,0.5)",fontSize:10,marginTop:4}}>{CURRENT_SESSION} · {CURRENT_TERM}</div>
      </div>
    </div>

    {/* Live clock + next calendar event */}
    <SchoolCalendarWidget settings={settings}/>

    {/* Birthday alert */}
    {(bday_s.length>0||bday_t.length>0)&&<div style={{...S.card,background:"linear-gradient(135deg,#FFFBEB,#FEF3C7)",border:`2px solid ${C.gold}`,marginBottom:16}}>
      <div style={{...S.row,gap:10}}><span style={{fontSize:22}}>🎂</span>
        <div><div style={{fontWeight:700,color:C.primaryDark,fontSize:13}}>Birthday Today!</div>
          <div style={{fontSize:12,color:C.textMuted,marginTop:2}}>{[...bday_s.map(s=>`${s.firstname} ${s.surname} (Student − ${s.class}${s.arm})`), ...bday_t.map(s=>`${s.firstname} ${s.surname} (Staff)`)].join(" · ")}</div>
        </div>
      </div>
    </div>}

    {/* Quick stats */}
    <div style={S.statsGrid}>
      {quickStats.map((s,i)=>(
        <div key={i} style={S.statCard()}>
          <div style={S.statNum}>{s.v}</div>
          <div style={S.statLabel}>{s.l}</div>
        </div>
      ))}
    </div>

    {/* Module cards — only show what user can access */}
    <div style={{marginBottom:8}}>
      <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:14,paddingBottom:8,borderBottom:`2px solid ${C.primary}`}}>
        Your Modules — click to open
      </div>
      {accessibleModules.length===0&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No modules have been assigned to your account yet. Contact the root admin.</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:14}}>
        {accessibleModules.map(n=>{
          const mc=MODULE_COLORS[n.id]||{bg:"#F9FAFB",accent:C.primary,emoji:"📁"};
          return(
            <div key={n.id} onClick={()=>onNavigate(n.id)} style={{background:mc.bg,border:`2px solid transparent`,borderRadius:12,padding:"18px 14px",cursor:"pointer",textAlign:"center",transition:"all 0.2s",userSelect:"none"}}
              onMouseEnter={e=>{e.currentTarget.style.border=`2px solid ${mc.accent}`;e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow=`0 8px 20px rgba(0,0,0,0.12)`;}}
              onMouseLeave={e=>{e.currentTarget.style.border="2px solid transparent";e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="none";}}>
              <div style={{fontSize:28,marginBottom:8}}>{mc.emoji}</div>
              <div style={{fontWeight:700,fontSize:12,color:mc.accent}}>{n.label}</div>
              <div style={{fontSize:10,color:C.textMuted,marginTop:4}}>Click to open →</div>
            </div>
          );
        })}
      </div>
    </div>

    {/* Calendar upcoming */}
    {userCanAccess(currentUser,"settings")&&<div style={{...S.card,marginTop:16}}>
      <div style={S.cardTitle}>Upcoming Calendar Events</div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        {settings.calendarEvents.filter(e=>e.date>=today()).slice(0,5).map(e=>(
          <div key={e.id} style={{background:e.type==="Exam"?C.dangerLight:e.type==="Holiday"?C.warningLight:C.successLight,borderRadius:8,padding:"8px 12px",minWidth:130}}>
            <div style={{fontSize:9,fontWeight:700,color:C.textMuted,textTransform:"uppercase"}}>{e.type}</div>
            <div style={{fontWeight:600,fontSize:11,marginTop:2}}>{e.title}</div>
            <div style={{fontSize:10,color:C.textMuted,marginTop:2}}>{formatDate(e.date)}</div>
          </div>
        ))}
        {settings.calendarEvents.filter(e=>e.date>=today()).length===0&&<div style={{fontSize:12,color:C.textMuted}}>No upcoming events.</div>}
      </div>
    </div>}
  </div>);
}



const SEED_LESSONS = [
  {id:"L001",teacherId:"T002",date:"2026-06-25",class:"JSS3",arm:"A",subject:"English Language",period:1,time:"8:00 AM - 9:00 AM",topic:"Comprehension Passage",subtopic:"Reading for Gist",textbook:"New Oxford Secondary English Book 3",instructionalMaterials:"Textbook, charts, comprehension passage printed copies",previousKnowledge:"Students have learnt vocabulary building in previous lessons",behaviouralObjectives:"By the end of this lesson, students should be able to: 1. Read a passage fluently 2. Answer comprehension questions correctly 3. Identify the main idea of a passage",stepOne:{title:"Introduction / Set Induction",content:"Teacher greets the class and recaps previous lesson on vocabulary. Teacher presents a short paragraph on the board and asks students what they notice about it."},stepTwo:{title:"Presentation",content:"Teacher reads the comprehension passage aloud while students follow. Teacher explains difficult words and expressions found in the passage. Students are asked to read in turns."},stepThree:{title:"Activity / Practice",content:"Students answer the comprehension questions in their exercise books. Teacher moves round to guide and correct students individually."},revision:"Teacher asks 3 students to summarize the passage in their own words. Class discusses the main points together.",evaluation:"1. What is the main idea of the passage? 2. Mention two characters in the passage. 3. What is the meaning of the word 'perseverance' as used in the passage?",assignment:"Read pages 45-50 of your English textbook and write a summary of the passage in not more than 100 words.",videoLinks:[{title:"How to answer comprehension questions",url:"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}],videoSearchSuggestions:[],status:"Published",submissionOpen:true,generationStatus:"manual",createdAt:"2026-06-25"},
];

const SEED_ASSIGNMENTS = [
  {id:"ASN001",lessonId:"L001",teacherId:"T002",class:"JSS3",subject:"English Language",title:"Comprehension Summary Assignment",description:"Read pages 45-50 of your English textbook and write a summary of the passage in not more than 100 words.",dueDate:"2026-06-28",maxScore:20,status:"Active",createdAt:"2026-06-25"},
];

const SEED_SUBMISSIONS = [
  {id:"SUB001",assignmentId:"ASN001",studentId:"S001",submittedAt:"2026-06-27",content:"The passage talks about the importance of hard work and perseverance in achieving success. The main character, Emeka, faced many challenges but never gave up. He eventually succeeded by studying hard every day and seeking help from his teachers. The story teaches us that no matter how difficult life gets, persistence always pays off in the end.",score:null,feedback:"",marked:false},
];


// ─── STYLES ───────────────────────────────────────────────
const S = {
  app:{display:"flex",height:"100vh",fontFamily:"'Segoe UI',system-ui,sans-serif",background:C.ivory,color:C.text,overflow:"hidden"},
  // On mobile, the sidebar becomes a fixed off-canvas drawer (slides in over
  // the content) instead of a permanent 240px column — a static-width
  // sidebar plus full content was forcing horizontal overflow on phones.
  sidebar:(isMobile,open)=>isMobile?{
    width:240,background:C.sidebarBg,display:"flex",flexDirection:"column",overflowY:"auto",
    position:"fixed",top:0,left:0,height:"100vh",zIndex:300,
    transform:open?"translateX(0)":"translateX(-100%)",transition:"transform 0.25s ease",
    boxShadow:open?"4px 0 20px rgba(0,0,0,0.3)":"none"
  }:{width:240,background:C.sidebarBg,display:"flex",flexDirection:"column",flexShrink:0,overflowY:"auto"},
  sidebarBackdrop:{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:250},
  sidebarLogo:{display:"flex",flexDirection:"column",alignItems:"center",padding:"16px 12px 12px",borderBottom:"1px solid rgba(255,255,255,0.08)"},
  logoImg:{width:64,height:64,objectFit:"contain",borderRadius:4},
  schoolName:{color:C.goldLight,fontSize:10,fontWeight:700,letterSpacing:"0.04em",lineHeight:1.3,marginTop:8,textAlign:"center"},
  schoolSub:{color:"rgba(255,255,255,0.4)",fontSize:9,textAlign:"center",marginTop:2},
  navSection:{padding:"8px 0 2px"},
  navLabel:{color:"rgba(255,255,255,0.3)",fontSize:9,letterSpacing:"0.1em",textTransform:"uppercase",padding:"0 14px 4px",fontWeight:600},
  navItem:(a)=>({display:"flex",alignItems:"center",gap:8,padding:"7px 14px",cursor:"pointer",background:a?"rgba(183,134,44,0.18)":"transparent",borderLeft:a?`3px solid ${C.gold}`:"3px solid transparent",color:a?C.goldLight:"rgba(255,255,255,0.6)",fontSize:11,fontWeight:a?600:400,userSelect:"none",transition:"all 0.15s"}),
  main:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0},
  topbar:{background:C.white,borderBottom:`1px solid ${C.border}`,padding:"11px 22px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0},
  pageTitle:{fontSize:16,fontWeight:700,color:C.primaryDark},
  sessionBadge:{background:C.primaryDark,color:C.goldLight,padding:"4px 12px",borderRadius:20,fontSize:11,fontWeight:600},
  content:(isMobile)=>({flex:1,overflowY:"auto",overflowX:"hidden",padding:isMobile?12:20}),
  hamburgerBtn:{display:"flex",alignItems:"center",justifyContent:"center",width:32,height:32,borderRadius:6,border:"none",background:"transparent",cursor:"pointer",flexShrink:0},
  card:{background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:16,marginBottom:14},
  cardTitle:{fontSize:12,fontWeight:700,color:C.primaryDark,marginBottom:11,paddingBottom:8,borderBottom:`1px solid ${C.border}`},
  statsGrid:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:10,marginBottom:16},
  statCard:(bg)=>({background:bg||C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"11px 13px"}),
  statNum:{fontSize:22,fontWeight:800,color:C.primaryDark,lineHeight:1},
  statLabel:{fontSize:10,color:C.textMuted,marginTop:3,fontWeight:500},
  btn:(v="primary",sm)=>({padding:sm?"5px 10px":"7px 13px",borderRadius:6,border:"none",cursor:"pointer",fontSize:sm?11:12,fontWeight:600,background:v==="primary"?C.primary:v==="danger"?C.danger:v==="gold"?C.gold:v==="success"?C.success:v==="ghost"?"transparent":v==="blue"?C.blue:"#F3F4F6",color:v==="ghost"?C.textMuted:v==="secondary"?C.text:C.white}),
  input:{width:"100%",padding:"7px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,outline:"none",background:C.white,boxSizing:"border-box"},
  textarea:{width:"100%",padding:"7px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,outline:"none",background:C.white,boxSizing:"border-box",resize:"vertical",minHeight:70},
  select:{padding:"7px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,outline:"none",background:C.white,cursor:"pointer"},
  label:{fontSize:11,fontWeight:600,color:C.textMuted,marginBottom:3,display:"block"},
  table:{width:"100%",borderCollapse:"collapse",fontSize:12},
  th:{textAlign:"left",padding:"8px 9px",background:C.primaryDark,color:C.goldLight,fontSize:10,fontWeight:700,letterSpacing:"0.04em",textTransform:"uppercase",whiteSpace:"nowrap"},
  thC:{textAlign:"center",padding:"8px 6px",background:C.primaryDark,color:C.goldLight,fontSize:10,fontWeight:700,whiteSpace:"nowrap"},
  td:{padding:"8px 9px",borderBottom:`1px solid ${C.border}`,verticalAlign:"middle"},
  tdC:{padding:"8px 5px",borderBottom:`1px solid ${C.border}`,textAlign:"center",verticalAlign:"middle"},
  badge:(col)=>({display:"inline-block",padding:"2px 7px",borderRadius:10,fontSize:10,fontWeight:600,background:col==="green"?C.successLight:col==="red"?C.dangerLight:col==="yellow"?C.warningLight:col==="blue"?C.blueLight:col==="orange"?C.orangeLight:"#F3F4F6",color:col==="green"?C.success:col==="red"?C.danger:col==="yellow"?C.warning:col==="blue"?C.blue:col==="orange"?C.orange:C.textMuted}),
  modal:{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20},
  modalBox:{background:C.white,borderRadius:12,padding:22,width:"100%",maxWidth:580,maxHeight:"92vh",overflowY:"auto"},
  grid2:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10},
  grid3:{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10},
  grid4:{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10},
  formGroup:{marginBottom:10},
  row:{display:"flex",gap:7,alignItems:"center"},
  gradeTag:(g)=>({background:["A1","B2","B3"].includes(g)?"#DCFCE7":["C4","C5","C6"].includes(g)?"#FEF3C7":"#FEE2E2",color:["A1","B2","B3"].includes(g)?"#166534":["C4","C5","C6"].includes(g)?"#92400E":"#B91C1C",padding:"1px 5px",borderRadius:3,fontSize:10,fontWeight:700,display:"inline-block"}),
  feeStatus:(s)=>({padding:"3px 10px",borderRadius:6,fontSize:11,fontWeight:700,background:s==="Paid"?"#DCFCE7":s==="Part-Payment"?"#FEF3C7":"#FEE2E2",color:s==="Paid"?"#166534":s==="Part-Payment"?"#92400E":"#B91C1C",border:`2px solid ${s==="Paid"?"#166534":s==="Part-Payment"?"#92400E":"#B91C1C"}`}),
  attDot:(present)=>({width:32,height:32,borderRadius:"50%",border:`2px solid ${present===true?C.success:present===false?C.danger:C.border}`,background:present===true?C.successLight:present===false?C.dangerLight:"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,cursor:"pointer",userSelect:"none"}),
};

function MiniBar({value,max=100,color=C.primary,height=8}){
  const pct=max?Math.min(100,(value/max)*100):0;
  return(<div style={{height,background:C.border,borderRadius:4,overflow:"hidden",minWidth:40}}>
    <div style={{height:"100%",width:`${pct}%`,background:color,borderRadius:4}}/>
  </div>);
}

function Icon({name,size=16,color="currentColor"}){
  const p={stroke:color,strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",fill:"none"};
  const icons={
    dashboard:<><rect x="3" y="3" width="7" height="7" rx="1" {...p}/><rect x="14" y="3" width="7" height="7" rx="1" {...p}/><rect x="3" y="14" width="7" height="7" rx="1" {...p}/><rect x="14" y="14" width="7" height="7" rx="1" {...p}/></>,
    students:<><circle cx="12" cy="8" r="4" {...p}/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" {...p}/></>,
    results:<><path d="M9 11l3 3L22 4" {...p}/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" {...p}/></>,
    fees:<><rect x="2" y="5" width="20" height="14" rx="2" {...p}/><line x1="2" y1="10" x2="22" y2="10" {...p}/></>,
    attendance:<><rect x="3" y="4" width="18" height="18" rx="2" {...p}/><line x1="16" y1="2" x2="16" y2="6" {...p}/><line x1="8" y1="2" x2="8" y2="6" {...p}/><line x1="3" y1="10" x2="21" y2="10" {...p}/></>,
    conduct:<><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" {...p}/></>,
    promotions:<><path d="M17 3l4 4-4 4" {...p}/><path d="M3 11V9a4 4 0 014-4h14" {...p}/><path d="M7 21l-4-4 4-4" {...p}/><path d="M21 13v2a4 4 0 01-4 4H3" {...p}/></>,
    spreadsheet:<><rect x="3" y="3" width="18" height="18" rx="2" {...p}/><line x1="3" y1="9" x2="21" y2="9" {...p}/><line x1="3" y1="15" x2="21" y2="15" {...p}/><line x1="9" y1="3" x2="9" y2="21" {...p}/><line x1="15" y1="3" x2="15" y2="21" {...p}/></>,
    analytics:<><line x1="18" y1="20" x2="18" y2="10" {...p}/><line x1="12" y1="20" x2="12" y2="4" {...p}/><line x1="6" y1="20" x2="6" y2="14" {...p}/></>,
    subject:<><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" {...p}/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" {...p}/></>,
    staff:<><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" {...p}/><circle cx="9" cy="7" r="4" {...p}/><path d="M23 21v-2a4 4 0 00-3-3.87" {...p}/><path d="M16 3.13a4 4 0 010 7.75" {...p}/></>,
    timetable:<><rect x="3" y="4" width="18" height="18" rx="2" {...p}/><line x1="16" y1="2" x2="16" y2="6" {...p}/><line x1="8" y1="2" x2="8" y2="6" {...p}/><line x1="3" y1="10" x2="21" y2="10" {...p}/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" {...p}/></>,
    messages:<><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" {...p}/></>,
    welfare:<><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" {...p}/></>,
    settings:<><circle cx="12" cy="12" r="3" {...p}/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" {...p}/></>,
    expenditure:<><line x1="12" y1="1" x2="12" y2="23" {...p}/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" {...p}/></>,
    plus:<><line x1="12" y1="5" x2="12" y2="19" {...p}/><line x1="5" y1="12" x2="19" y2="12" {...p}/></>,
    edit:<><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" {...p}/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" {...p}/></>,
    trash:<><polyline points="3 6 5 6 21 6" {...p}/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" {...p}/></>,
    eye:<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" {...p}/><circle cx="12" cy="12" r="3" {...p}/></>,
    search:<><circle cx="11" cy="11" r="8" {...p}/><line x1="21" y1="21" x2="16.65" y2="16.65" {...p}/></>,
    close:<><line x1="18" y1="6" x2="6" y2="18" {...p}/><line x1="6" y1="6" x2="18" y2="18" {...p}/></>,
    menu:<><line x1="3" y1="6" x2="21" y2="6" {...p}/><line x1="3" y1="12" x2="21" y2="12" {...p}/><line x1="3" y1="18" x2="21" y2="18" {...p}/></>,
    download:<><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" {...p}/><polyline points="7 10 12 15 17 10" {...p}/><line x1="12" y1="15" x2="12" y2="3" {...p}/></>,
    print:<><polyline points="6 9 6 2 18 2 18 9" {...p}/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" {...p}/><rect x="6" y="14" width="12" height="8" {...p}/></>,
    whatsapp:<><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" {...p}/></>,
    sms:<><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.73 7.18a19.79 19.79 0 01-3.07-8.67A2 2 0 013.64 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-.81a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 17.92z" {...p}/></>,
    birthday:<><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" {...p}/><circle cx="12" cy="7" r="4" {...p}/></>,
    lock:<><rect x="3" y="11" width="18" height="11" rx="2" ry="2" {...p}/><path d="M7 11V7a5 5 0 0110 0v4" {...p}/></>,
    idcard:<><rect x="2" y="5" width="20" height="14" rx="2" {...p}/><circle cx="8" cy="11" r="2" {...p}/><line x1="8" y1="16" x2="8" y2="16" {...p}/><line x1="13" y1="9" x2="18" y2="9" {...p}/><line x1="13" y1="13" x2="18" y2="13" {...p}/></>,
    diary:<><path d="M4 19.5A2.5 2.5 0 016.5 17H20" {...p}/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" {...p}/><line x1="9" y1="7" x2="15" y2="7" {...p}/><line x1="9" y1="11" x2="15" y2="11" {...p}/></>,
    gallery:<><rect x="3" y="3" width="18" height="18" rx="2" {...p}/><circle cx="8.5" cy="8.5" r="1.5" {...p}/><path d="M21 15l-5-5L5 21" {...p}/></>,
    clinic:<><path d="M22 12h-4l-3 9L9 3l-3 9H2" {...p}/></>,
    counsellor:<><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" {...p}/></>,
    exams:<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" {...p}/><polyline points="14 2 14 8 20 8" {...p}/><line x1="16" y1="13" x2="8" y2="13" {...p}/><line x1="16" y1="17" x2="8" y2="17" {...p}/><polyline points="10 9 9 9 8 9" {...p}/></>,
    admissions:<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" {...p}/><polyline points="14 2 14 8 20 8" {...p}/><line x1="16" y1="13" x2="8" y2="13" {...p}/><line x1="16" y1="17" x2="8" y2="17" {...p}/><polyline points="10 9 9 9 8 9" {...p}/></>,
    elibrary:<><path d="M4 19.5A2.5 2.5 0 016.5 17H20" {...p}/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" {...p}/><polyline points="12 2 12 10 9 7 12 10 15 7 12 10" {...p}/></>,
    hostel:<><path d="M3 12L12 3l9 9" {...p}/><path d="M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10" {...p}/></>,
  };
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24">{icons[name]||null}</svg>;
}

function Modal({open,onClose,title,children,wide,extraWide}){
  if(!open)return null;
  return(<div style={S.modal} onClick={onClose}>
    <div style={{...S.modalBox,maxWidth:extraWide?1000:wide?720:560}} onClick={e=>e.stopPropagation()}>
      <div style={{...S.row,justifyContent:"space-between",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:C.primaryDark}}>{title}</div>
        <button style={{...S.btn("ghost"),padding:3}} onClick={onClose}><Icon name="close" size={16}/></button>
      </div>
      {children}
    </div>
  </div>);
}

function Tabs({tabs,active,onChange}){
  return(<div style={{...S.row,marginBottom:14,gap:4,borderBottom:`2px solid ${C.border}`,paddingBottom:0}}>
    {tabs.map(([id,label])=><button key={id} onClick={()=>onChange(id)} style={{...S.btn(active===id?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11}}>{label}</button>)}
  </div>);
}

function SMSButton({phone,message,label="Send SMS"}){
  const [sent,setSent]=useState(false);
  function handle(){sendSMS(phone,message,label);setSent(true);setTimeout(()=>setSent(false),3000);}
  return(<button style={{...S.btn(sent?"success":"primary"),true:11,padding:"5px 10px",fontSize:11}} onClick={handle}><span style={S.row}><Icon name="sms" size={12}/>{sent?"Sent!":label}</span></button>);
}

function PrintButton({onPrint,label="Print"}){
  return(<button style={{...S.btn("secondary"),fontSize:11,padding:"5px 10px"}} onClick={onPrint}><span style={S.row}><Icon name="print" size={12}/>{label}</span></button>);
}
function WhatsAppButton({phone,message,label="WhatsApp"}){
  function handle(){const url=`https://wa.me/234${phone.replace(/^0/,"")}?text=${encodeURIComponent(message)}`;window.open(url,"_blank");}
  return(<button style={{...S.btn("success"),fontSize:11,padding:"5px 10px"}} onClick={handle}><span style={S.row}><Icon name="whatsapp" size={12}/>{label}</span></button>);
}

// Shared form-field renderer for modal edit forms. Defined once at module
// scope (not inline inside a form component's own function body) — a
// component defined inline gets a brand-new function identity every render,
// which makes React treat it as a different component type and remount the
// underlying <input> DOM node on every keystroke, silently dropping focus
// after the first character typed. This is what "value, onChange, form,
// setForm" as explicit props (instead of closures) fixes.
function FormField({label,field,type="text",opts,required,sub,form,setForm}){
  const value = sub ? form[sub][field] : form[field];
  function onChange(e){
    const v = e.target.value;
    if(sub) setForm(p=>({...p,[sub]:{...p[sub],[field]:v}}));
    else setForm(p=>({...p,[field]:v}));
  }
  return (
    <div style={S.formGroup}>
      <label style={S.label}>{label}{required&&<span style={{color:C.danger}}> *</span>}</label>
      {opts?<select style={{...S.select,width:"100%"}} value={value} onChange={onChange}>{opts.map(o=><option key={o}>{o}</option>)}</select>
      :type==="textarea"?<textarea style={{...S.textarea,minHeight:sub?60:50}} value={value} onChange={onChange}/>
      :<input style={S.input} type={type} value={value} onChange={onChange}/>}
    </div>
  );
}

// Print / Download PDF / Share toolbar for an already-built printable HTML
// document (receipts, report cards, ID cards, admission letters, etc.).
// getHtml is a function (not a string) so it's always built fresh from
// current data at click time, same as the existing printX() functions.
function DocActionBar({getHtml,filename,title}){
  const [busy,setBusy]=useState("");
  async function handlePDF(){
    setBusy("pdf");
    try{ await downloadHtmlDocAsPDF(getHtml(), filename); }
    catch(e){ alert("Could not generate PDF: "+e.message); }
    setBusy("");
  }
  async function handleShare(){
    setBusy("share");
    try{ await shareHtmlDoc(getHtml(), filename, title); }
    catch(e){ alert("Could not share: "+e.message); }
    setBusy("");
  }
  function handlePrint(){ printHtmlDoc(getHtml()); }
  return(
    <div style={{...S.row,gap:6,flexWrap:"wrap"}}>
      <button style={{...S.btn("secondary"),fontSize:11,padding:"5px 10px"}} onClick={handlePrint}><span style={S.row}><Icon name="print" size={12}/>Print</span></button>
      <button style={{...S.btn("secondary"),fontSize:11,padding:"5px 10px",opacity:busy==="pdf"?0.6:1}} onClick={handlePDF} disabled={!!busy}><span style={S.row}>📄 {busy==="pdf"?"Generating...":"PDF"}</span></button>
      <button style={{...S.btn("secondary"),fontSize:11,padding:"5px 10px",opacity:busy==="share"?0.6:1}} onClick={handleShare} disabled={!!busy}><span style={S.row}>📤 {busy==="share"?"Sharing...":"Share"}</span></button>
    </div>
  );
}

// Excel / PDF / Print toolbar for a raw tabular export (list tables,
// broadsheets, attendance registers, financial statements, etc.)
function TableActionBar({title,subtitle,columns,rows,filename,onPrint}){
  const [busy,setBusy]=useState("");
  function handleExcel(){ exportTableToExcel({sheetName:title,columns,rows,filename:filename||title}); }
  function handlePDF(){ exportTableToPDF({title,subtitle,columns,rows,filename:filename||title}); }
  async function handleShare(){
    setBusy("share");
    try{ await shareTableAsPDF({title,subtitle,columns,rows,filename:filename||title}); }
    catch(e){ alert("Could not share: "+e.message); }
    setBusy("");
  }
  return(
    <div style={{...S.row,gap:6,flexWrap:"wrap"}}>
      {onPrint&&<button style={{...S.btn("secondary"),fontSize:11,padding:"5px 10px"}} onClick={onPrint}><span style={S.row}><Icon name="print" size={12}/>Print</span></button>}
      <button style={{...S.btn("secondary"),fontSize:11,padding:"5px 10px"}} onClick={handleExcel}><span style={S.row}>📊 Excel</span></button>
      <button style={{...S.btn("secondary"),fontSize:11,padding:"5px 10px"}} onClick={handlePDF}><span style={S.row}>📄 PDF</span></button>
      <button style={{...S.btn("secondary"),fontSize:11,padding:"5px 10px",opacity:busy?0.6:1}} onClick={handleShare} disabled={!!busy}><span style={S.row}>📤 {busy?"Sharing...":"Share"}</span></button>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// ANALYTICS — Student disaggregation: sex, age, class,
//             enrolment per term/session, active/inactive
// ══════════════════════════════════════════════════════

// ── Pure CSS/SVG Chart Helpers ─────────────────────
// ── Pure CSS/SVG Chart Helpers ─────────────────────
function CSSBarChart({data, keys, colors, height, maxVal}){
  var h = height || 200;
  var max = maxVal || Math.max.apply(null, data.reduce(function(acc,d){ keys.forEach(function(k){ acc.push(d[k]||0); }); return acc; }, [1]));
  if(max===0) max=1;
  return(
    <div style={{width:"100%",overflowX:"auto"}}>
      <div style={{display:"flex",alignItems:"flex-end",gap:6,height:h,padding:"0 8px 0 32px",borderBottom:"2px solid #E5E7EB",borderLeft:"2px solid #E5E7EB",position:"relative",minWidth:Math.max(data.length*60,300)}}>
        {[0,25,50,75,100].filter(function(v){return v<=max+5;}).map(function(v){
          return <div key={v} style={{position:"absolute",left:0,bottom:(v/max)*h-8,fontSize:9,color:"#9CA3AF",width:28,textAlign:"right"}}>{v}</div>;
        })}
        {data.map(function(d,di){
          return(
            <div key={di} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center"}}>
              <div style={{display:"flex",alignItems:"flex-end",gap:2,height:h}}>
                {keys.map(function(k,ki){
                  var val=d[k]||0;
                  var pct=(val/max)*100;
                  return(
                    <div key={k} title={k+": "+val} style={{width:keys.length>3?10:keys.length>1?14:22,height:Math.max((pct/100)*h,val>0?2:0),background:colors[ki],borderRadius:"2px 2px 0 0",position:"relative",flexShrink:0}}>
                      {val>0 ? <span style={{position:"absolute",top:-14,left:"50%",transform:"translateX(-50%)",fontSize:7,color:"#374151",fontWeight:600,whiteSpace:"nowrap"}}>{val}</span> : null}
                    </div>
                  );
                })}
              </div>
              <div style={{fontSize:8,color:"#374151",fontWeight:600,textAlign:"center",marginTop:4,maxWidth:60,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.label||d.class||d.range||d.session||d.subject||""}</div>
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",gap:14,flexWrap:"wrap",marginTop:10,paddingLeft:32}}>
        {keys.map(function(k,i){
          return(
            <div key={k} style={{display:"flex",alignItems:"center",gap:4}}>
              <div style={{width:10,height:10,background:colors[i],borderRadius:2}}/>
              <span style={{fontSize:10,color:"#374151"}}>{k}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SVGPieChart({data, size}){
  var sz = size || 200;
  var total = data.reduce(function(a,d){return a+d.value;},0);
  if(total===0){
    return <div style={{textAlign:"center",color:"#9CA3AF",padding:20}}>No data</div>;
  }
  var cx=sz/2, cy=sz/2, r=sz*0.38;
  var angle=-90;
  var slices=data.map(function(d){
    var pct=d.value/total;
    var start=angle;
    angle+=pct*360;
    var mid=(start+angle)/2;
    var rad=mid*Math.PI/180;
    return {name:d.name,value:d.value,fill:d.fill,start:start,end:angle,pct:pct,lx:cx+r*0.65*Math.cos(rad),ly:cy+r*0.65*Math.sin(rad)};
  });
  function arc(s,e){
    var large=e-s>180?1:0;
    var sr=s*Math.PI/180; var er=e*Math.PI/180;
    var x1=cx+r*Math.cos(sr); var y1=cy+r*Math.sin(sr);
    var x2=cx+r*Math.cos(er); var y2=cy+r*Math.sin(er);
    return "M "+cx+" "+cy+" L "+x1+" "+y1+" A "+r+" "+r+" 0 "+large+" 1 "+x2+" "+y2+" Z";
  }
  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
      <svg width={sz} height={sz} viewBox={"0 0 "+sz+" "+sz}>
        {slices.map(function(s,i){
          return(
            <g key={i}>
              <path d={arc(s.start,s.end)} fill={s.fill} stroke="#fff" strokeWidth={2}>
                <title>{s.name}: {s.value} ({(s.pct*100).toFixed(1)}%)</title>
              </path>
              {s.pct>0.07 ? <text x={s.lx} y={s.ly} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={9} fontWeight="700">{(s.pct*100).toFixed(0)}%</text> : null}
            </g>
          );
        })}
      </svg>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center",marginTop:6}}>
        {slices.map(function(s,i){
          return(
            <div key={i} style={{display:"flex",alignItems:"center",gap:4}}>
              <div style={{width:10,height:10,background:s.fill,borderRadius:2}}/>
              <span style={{fontSize:10,color:"#374151"}}>{s.name}: <b>{s.value}</b></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AnalyticsModule({students, attendance, results, settings}){
  var rc = getResultConfig(settings);
  var _tab = useState("students");
  var tab = _tab[0]; var setTab = _tab[1];
  var _sc = useState("JSS1");
  var selClass = _sc[0]; var setSelClass = _sc[1];
  var _ss = useState(CURRENT_SESSION);
  var selSess = _ss[0]; var setSelSess = _ss[1];
  var _st = useState(CURRENT_TERM);
  var selTerm = _st[0]; var setSelTerm = _st[1];

  var NAVY="#230E6A"; var BRONZE="#6B491B"; var BLUE="#1D4ED8";
  var GREEN="#059669"; var TEAL="#0891B2";
  var COLORS=[NAVY,BRONZE,BLUE,GREEN,TEAL,"#7C3AED","#DC2626","#D97706"];
  var AGE_ORDER=["Under 10","10–11","12–13","14–15","16–17","18–19","20+","Unknown"];

  function getAge(dob){ return dob ? Math.floor((new Date()-new Date(dob))/(1000*60*60*24*365.25)) : null; }
  function getAgeRange(age){
    if(age===null) return "Unknown";
    if(age<10) return "Under 10"; if(age<=11) return "10–11"; if(age<=13) return "12–13";
    if(age<=15) return "14–15"; if(age<=17) return "16–17"; if(age<=19) return "18–19"; return "20+";
  }

  var ALL=students;
  var ACTIVE=students.filter(function(s){return s.active;});

  // DEMOGRAPHICS
  var sexData=[{name:"Male",value:ACTIVE.filter(function(s){return s.gender==="Male";}).length,fill:NAVY},{name:"Female",value:ACTIVE.filter(function(s){return s.gender==="Female";}).length,fill:BRONZE}];
  var boardingData=[{name:"Day",value:ACTIVE.filter(function(s){return s.boardingType==="Day";}).length,fill:BLUE},{name:"Boarder",value:ACTIVE.filter(function(s){return s.boardingType==="Boarder";}).length,fill:GREEN}];
  var classData=CLASSES.map(function(cls){return{class:cls,label:cls,total:ACTIVE.filter(function(s){return s.class===cls;}).length,male:ACTIVE.filter(function(s){return s.class===cls&&s.gender==="Male";}).length,female:ACTIVE.filter(function(s){return s.class===cls&&s.gender==="Female";}).length,day:ACTIVE.filter(function(s){return s.class===cls&&s.boardingType==="Day";}).length,boarder:ACTIVE.filter(function(s){return s.class===cls&&s.boardingType==="Boarder";}).length};});
  var ageMap={};
  ACTIVE.forEach(function(s){var r=getAgeRange(getAge(s.dob));ageMap[r]=(ageMap[r]||0)+1;});
  var ageData=AGE_ORDER.filter(function(r){return ageMap[r];}).map(function(r){return{range:r,label:r,total:ageMap[r],male:ACTIVE.filter(function(s){return s.gender==="Male"&&getAgeRange(getAge(s.dob))===r;}).length,female:ACTIVE.filter(function(s){return s.gender==="Female"&&getAgeRange(getAge(s.dob))===r;}).length};});
  var relMap={};ACTIVE.forEach(function(s){var r=s.religion||"Unknown";relMap[r]=(relMap[r]||0)+1;});
  var relData=Object.entries(relMap).map(function(e,i){return{name:e[0],value:e[1],fill:COLORS[i]||"#6B7280"};});
  var bgMap={};ACTIVE.forEach(function(s){var b=s.bloodGroup||"?";bgMap[b]=(bgMap[b]||0)+1;});
  var bgData=Object.entries(bgMap).sort(function(a,b){return b[1]-a[1];}).map(function(e){return{range:e[0],label:e[0],count:e[1]};});
  var genMap={};ACTIVE.forEach(function(s){var g=s.genotype||"?";genMap[g]=(genMap[g]||0)+1;});
  var genData=Object.entries(genMap).sort(function(a,b){return b[1]-a[1];}).map(function(e){return{range:e[0],label:e[0],count:e[1]};});
  var ssCount=(genMap["SS"]||0);

  // ENROLMENT
  var sessionData=SESSIONS.map(function(sess){
    var en=ALL.filter(function(s){return s.entrySession===sess;});
    var ac=en.filter(function(s){return s.active;});
    var male=en.filter(function(s){return s.gender==="Male";}).length;
    var female=en.filter(function(s){return s.gender==="Female";}).length;
    return{label:sess.replace("/","–"),session:sess.replace("/","–"),enrolled:en.length,active:ac.length,male:male,female:female,retained:en.length?Math.round(ac.length/en.length*100):0};
  }).filter(function(d){return d.enrolled>0;});

  var termActivity=[];
  SESSIONS.forEach(function(sess){
    TERMS.forEach(function(t){
      var ids=[...new Set(attendance.filter(function(a){return a.session===sess&&a.term===t;}).map(function(a){return a.studentId;}))];
      var ts=students.filter(function(s){return ids.indexOf(s.id)>=0;});
      var count=ids.length;
      if(count>0){
        termActivity.push({label:t.slice(0,1)+"T "+sess.slice(2).split("/")[0],session:sess,term:t,count:count,male:ts.filter(function(s){return s.gender==="Male";}).length,female:ts.filter(function(s){return s.gender==="Female";}).length});
      }
    });
  });

  var classSessionData=CLASSES.map(function(cls){
    var row={class:cls,label:cls};
    SESSIONS.forEach(function(sess){row[sess.replace("/","–")]=ALL.filter(function(s){return s.entryClass===cls&&s.entrySession===sess;}).length;});
    return row;
  });

  // SUBJECTS
  var classResults=results.filter(function(r){return r.class===selClass&&r.session===selSess&&r.term===selTerm;});
  var subjectAnalytics=getSubjects(selClass).map(function(sub){
    var sr=classResults.filter(function(r){return r.subject===sub;}).map(function(r){return {...r,student:students.find(function(s){return s.id===r.studentId;})};}).filter(function(r){return r.student;});
    if(!sr.length) return null;
    var mA=sr.filter(function(r){return r.student&&r.student.gender==="Male";});
    var fA=sr.filter(function(r){return r.student&&r.student.gender==="Female";});
    var dA=sr.filter(function(r){return r.student&&r.student.boardingType==="Day";});
    var bA=sr.filter(function(r){return r.student&&r.student.boardingType==="Boarder";});
    var avg=sr.length?(sr.reduce(function(a,r){return a+r.total;},0)/sr.length).toFixed(1):null;
    return{subject:sub,label:sub.length>10?sub.slice(0,10)+"…":sub,count:sr.length,avg:avg,highest:Math.max.apply(null,sr.map(function(r){return r.total;})),lowest:Math.min.apply(null,sr.map(function(r){return r.total;})),pass:sr.filter(function(r){return r.total>=rc.passMark;}).length,fail:sr.filter(function(r){return r.total<rc.passMark;}).length,maleAvg:mA.length?(mA.reduce(function(a,r){return a+r.total;},0)/mA.length).toFixed(1):null,femaleAvg:fA.length?(fA.reduce(function(a,r){return a+r.total;},0)/fA.length).toFixed(1):null,dayAvg:dA.length?(dA.reduce(function(a,r){return a+r.total;},0)/dA.length).toFixed(1):null,boarderAvg:bA.length?(bA.reduce(function(a,r){return a+r.total;},0)/bA.length).toFixed(1):null};
  }).filter(function(s){return s!==null;});

  // CLASS RESULTS
  var classResultsOverall=CLASSES.map(function(cls){
    var cs=ACTIVE.filter(function(s){return s.class===cls;});
    var cr=results.filter(function(r){return r.class===cls&&r.session===selSess&&r.term===selTerm;});
    var savgs=cs.map(function(s){var sr=cr.filter(function(r){return r.studentId===s.id;});var a=sr.length?(sr.reduce(function(x,r){return x+r.total;},0)/sr.length):null;return{student:s,avg:a};}).filter(function(s){return s.avg!==null;});
    var cavg=savgs.length?(savgs.reduce(function(a,s){return a+s.avg;},0)/savgs.length).toFixed(1):null;
    var mA=savgs.filter(function(s){return s.student.gender==="Male";}); var fA=savgs.filter(function(s){return s.student.gender==="Female";});
    var dA=savgs.filter(function(s){return s.student.boardingType==="Day";}); var bA=savgs.filter(function(s){return s.student.boardingType==="Boarder";});
    var gb={A1:0,B2:0,B3:0,C4:0,C5:0,C6:0,D7:0,E8:0,F9:0};
    cr.forEach(function(r){var g=getGrade(r.total,settings).grade;if(gb[g]!==undefined)gb[g]++;});
    return{cls:cls,label:cls,enrolled:cs.length,withResults:savgs.length,classAvg:cavg,passRate:savgs.length?Math.round(savgs.filter(function(s){return s.avg>=rc.passMark;}).length/savgs.length*100):null,maleAvg:mA.length?(mA.reduce(function(a,s){return a+s.avg;},0)/mA.length).toFixed(1):null,femaleAvg:fA.length?(fA.reduce(function(a,s){return a+s.avg;},0)/fA.length).toFixed(1):null,dayAvg:dA.length?(dA.reduce(function(a,s){return a+s.avg;},0)/dA.length).toFixed(1):null,boarderAvg:bA.length?(bA.reduce(function(a,s){return a+s.avg;},0)/bA.length).toFixed(1):null,gradeBreakdown:gb};
  });

  var classAvgData=classResultsOverall.filter(function(c){return c.classAvg;}).map(function(c){return{label:c.cls,overall:parseFloat(c.classAvg)||0,male:parseFloat(c.maleAvg)||0,female:parseFloat(c.femaleAvg)||0,day:parseFloat(c.dayAvg)||0,boarder:parseFloat(c.boarderAvg)||0};});
  var subAvgData=subjectAnalytics.map(function(s){return{label:s.label,avg:parseFloat(s.avg)||0,male:parseFloat(s.maleAvg)||0,female:parseFloat(s.femaleAvg)||0};});

  var TABS=[["students","👥 Demographics"],["enrolment","📈 Enrolment"],["subjects","📚 Subjects"],["classresults","📊 Class Results"]];

  function printAnalytics(){
    var tabLabel = TABS.find(function(t){return t[0]===tab;}); var tl = tabLabel?tabLabel[1]:"Analytics";
    var printArea = document.getElementById("analytics-print-area");
    if(!printArea) return alert("Nothing to print.");
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Analytics — '+tl+'</title><style>'+
      '*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;font-size:10px;padding:12px;}'+
      'table{width:100%;border-collapse:collapse;margin-bottom:10px;}'+
      'th{background:#230E6A;color:#fff;padding:5px;font-size:9px;}td{padding:4px 5px;border:1px solid #ddd;font-size:9px;}'+
      '.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px;}'+
      '.stat-card{border:1px solid #E5E7EB;border-radius:6px;padding:8px;text-align:center;}'+
      '.stat-num{font-size:18px;font-weight:900;color:#230E6A;}'+
      '.stat-label{font-size:9px;color:#6B7280;}'+
      '@media print{body{padding:5mm;}-webkit-print-color-adjust:exact;print-color-adjust:exact;}'+
    '</style></head><body>'+
    '<div style="display:flex;align-items:center;gap:10px;border-bottom:3px solid #8B0000;padding-bottom:8px;margin-bottom:10px;">'+
    '<div style="flex:1;text-align:center;">'+
    '<div style="font-size:18px;font-weight:900;color:#8B0000;">'+SCHOOL_NAME+'</div>'+
    '<div style="font-size:10px;color:#555;">'+SCHOOL_ADDRESS+' | Tel: 08039650771</div>'+
    '</div></div>'+
    '<div style="text-align:center;font-size:13px;font-weight:800;color:#8B0000;text-decoration:underline;margin:6px 0;">ANALYTICS REPORT — '+tl.toUpperCase()+'</div>'+
    '<div style="font-size:9px;color:#666;text-align:right;margin-bottom:8px;">Generated: '+new Date().toLocaleDateString()+'</div>'+
    printArea.innerHTML+
    '</body></html>';
    var w = window.open("","_blank");
    if(w){ w.document.write(html); w.document.close(); w.print(); }
  }


  function renderDemographics(){
    return(
      <div>
        <div style={S.statsGrid}>
          {[{l:"Total Enrolled",v:ALL.length,bg:"#F5F3FB"},{l:"Active",v:ACTIVE.length,bg:"#F0FDF4"},{l:"Male",v:ACTIVE.filter(function(s){return s.gender==="Male";}).length,bg:"#EFF6FF"},{l:"Female",v:ACTIVE.filter(function(s){return s.gender==="Female";}).length,bg:"#FFF7ED"},{l:"Day",v:ACTIVE.filter(function(s){return s.boardingType==="Day";}).length,bg:"#EFF6FF"},{l:"Boarders",v:ACTIVE.filter(function(s){return s.boardingType==="Boarder";}).length,bg:"#FFFBEB"},{l:"Exited",v:ALL.filter(function(s){return !s.active;}).length,bg:"#FEF2F2"},{l:"Classes",v:CLASSES.length,bg:"#F5F3FB"}].map(function(s,i){return(
            <div key={i} style={S.statCard(s.bg)}><div style={{...S.statNum,fontSize:18}}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>
          );})}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
          <div style={S.card}><div style={S.cardTitle}>Gender Split</div><SVGPieChart data={sexData} size={200}/></div>
          <div style={S.card}><div style={S.cardTitle}>Boarding Type</div><SVGPieChart data={boardingData} size={200}/></div>
        </div>
        <div style={{...S.card,marginBottom:14}}>
          <div style={S.cardTitle}>Students Per Class — Gender &amp; Boarding</div>
          <CSSBarChart data={classData} keys={["male","female","day","boarder"]} colors={[NAVY,BRONZE,BLUE,GREEN]} height={200}/>
          <div style={{overflowX:"auto",marginTop:12}}>
            <table style={S.table}>
              <thead><tr>{["Class","Total","Male","Female","M%","F%","Day","Boarder"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
              <tbody>{classData.map(function(d){return(
                <tr key={d.class}><td style={{...S.td,fontWeight:700}}>{d.class}</td><td style={{...S.tdC,fontWeight:700}}>{d.total}</td><td style={{...S.tdC,color:NAVY,fontWeight:600}}>{d.male}</td><td style={{...S.tdC,color:BRONZE,fontWeight:600}}>{d.female}</td><td style={S.tdC}>{d.total?Math.round(d.male/d.total*100):0}%</td><td style={S.tdC}>{d.total?Math.round(d.female/d.total*100):0}%</td><td style={{...S.tdC,color:BLUE,fontWeight:600}}>{d.day}</td><td style={{...S.tdC,color:GREEN,fontWeight:600}}>{d.boarder}</td>
                </tr>
              );})}</tbody>
              <tfoot><tr style={{background:NAVY}}><td style={{...S.td,color:"#F0C060",fontWeight:700}}>TOTAL</td><td style={{...S.tdC,color:"#F0C060",fontWeight:700}}>{ACTIVE.length}</td><td style={{...S.tdC,color:"#F0C060",fontWeight:700}}>{ACTIVE.filter(function(s){return s.gender==="Male";}).length}</td><td style={{...S.tdC,color:"#F0C060",fontWeight:700}}>{ACTIVE.filter(function(s){return s.gender==="Female";}).length}</td><td colSpan={2}/><td style={{...S.tdC,color:"#F0C060",fontWeight:700}}>{ACTIVE.filter(function(s){return s.boardingType==="Day";}).length}</td><td style={{...S.tdC,color:"#F0C060",fontWeight:700}}>{ACTIVE.filter(function(s){return s.boardingType==="Boarder";}).length}</td></tr></tfoot>
            </table>
          </div>
        </div>
        <div style={{...S.card,marginBottom:14}}>
          <div style={S.cardTitle}>Age Range — Male vs Female</div>
          {ageData.length===0 ? <div style={{textAlign:"center",color:C.textMuted,padding:20}}>Add date-of-birth when enrolling students to see age breakdown.</div> : <CSSBarChart data={ageData} keys={["male","female"]} colors={[NAVY,BRONZE]} height={200}/>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>
          <div style={S.card}><div style={S.cardTitle}>Religion</div><SVGPieChart data={relData} size={180}/></div>
          <div style={S.card}><div style={S.cardTitle}>Blood Group</div><CSSBarChart data={bgData} keys={["count"]} colors={[NAVY]} height={160}/></div>
          <div style={S.card}><div style={S.cardTitle}>Genotype</div><CSSBarChart data={genData} keys={["count"]} colors={[BRONZE]} height={160}/>{ssCount>0 ? <div style={{fontSize:10,color:C.danger,marginTop:6,fontWeight:600}}>{"⚠ "+ssCount+" SS genotype student(s)"}</div> : null}</div>
        </div>
      </div>
    );
  }

  function renderEnrolment(){
    return(
      <div>
        <div style={{...S.card,marginBottom:14}}>
          <div style={S.cardTitle}>New Enrolments Per Session — Male vs Female</div>
          {sessionData.length===0 ? <div style={{textAlign:"center",color:C.textMuted,padding:24}}>No data yet.</div> : <div><CSSBarChart data={sessionData} keys={["enrolled","male","female","active"]} colors={[NAVY,BLUE,BRONZE,GREEN]} height={200}/><div style={{overflowX:"auto",marginTop:12}}><table style={S.table}><thead><tr>{["Session","Enrolled","Male","Female","M%","F%","Active","Retention"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead><tbody>{sessionData.map(function(d){return(<tr key={d.session}><td style={{...S.td,fontWeight:700}}>{d.session}</td><td style={{...S.tdC,fontWeight:700}}>{d.enrolled}</td><td style={{...S.tdC,color:NAVY,fontWeight:600}}>{d.male}</td><td style={{...S.tdC,color:BRONZE,fontWeight:600}}>{d.female}</td><td style={S.tdC}>{d.enrolled?Math.round(d.male/d.enrolled*100):0}%</td><td style={S.tdC}>{d.enrolled?Math.round(d.female/d.enrolled*100):0}%</td><td style={{...S.tdC,color:GREEN,fontWeight:600}}>{d.active}</td><td style={S.td}><span style={S.badge(d.retained>=80?"green":d.retained>=50?"yellow":"red")}>{d.retained}%</span></td></tr>);})}</tbody></table></div></div>}
        </div>
        <div style={{...S.card,marginBottom:14}}>
          <div style={S.cardTitle}>Active Students Per Term — Male vs Female</div>
          {termActivity.length===0 ? <div style={{textAlign:"center",color:C.textMuted,padding:24}}>Record attendance to populate this chart.</div> : <div><CSSBarChart data={termActivity} keys={["count","male","female"]} colors={[NAVY,BLUE,BRONZE]} height={200}/><div style={{overflowX:"auto",marginTop:12}}><table style={S.table}><thead><tr>{["Term","Session","Total","Male","Female","M%","F%"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead><tbody>{termActivity.map(function(d,i){return(<tr key={i}><td style={S.td}>{d.term}</td><td style={S.td}>{d.session}</td><td style={{...S.tdC,fontWeight:700}}>{d.count}</td><td style={{...S.tdC,color:NAVY,fontWeight:600}}>{d.male}</td><td style={{...S.tdC,color:BRONZE,fontWeight:600}}>{d.female}</td><td style={S.tdC}>{d.count?Math.round(d.male/d.count*100):0}%</td><td style={S.tdC}>{d.count?Math.round(d.female/d.count*100):0}%</td></tr>);})}</tbody></table></div></div>}
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>Enrolments By Entry Class Per Session</div>
          <div style={{overflowX:"auto"}}>
            <table style={S.table}>
              <thead><tr><th style={S.th}>Class</th>{SESSIONS.map(function(s){return <th key={s} style={S.thC}>{s}</th>;})}<th style={S.thC}>Total</th></tr></thead>
              <tbody>{classSessionData.map(function(d){return(<tr key={d.class}><td style={{...S.td,fontWeight:700}}>{d.class}</td>{SESSIONS.map(function(s){var v=d[s.replace("/","–")]||0;return <td key={s} style={{...S.tdC,fontWeight:v>0?600:400,color:v>0?NAVY:C.textMuted}}>{v||"—"}</td>;})} <td style={{...S.tdC,fontWeight:700,color:NAVY}}>{SESSIONS.reduce(function(a,s){return a+(d[s.replace("/","–")]||0);},0)}</td></tr>);})}</tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  function renderSubjects(){
    return(
      <div>
        <div style={{...S.card,marginBottom:14}}>
          <div style={S.grid3}>
            <div><label style={S.label}>Class</label><select style={{...S.select,width:"100%"}} value={selClass} onChange={function(e){setSelClass(e.target.value);}}>{CLASSES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
            <div><label style={S.label}>Session</label><select style={{...S.select,width:"100%"}} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>{SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
            <div><label style={S.label}>Term</label><select style={{...S.select,width:"100%"}} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>{TERMS.map(function(t){return <option key={t}>{t}</option>;})}</select></div>
          </div>
        </div>
        {subjectAnalytics.length===0 ? <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:36}}>{"No results for "+selClass+" — "+selTerm+" "+selSess+" yet."}</div> : <div><div style={{...S.card,marginBottom:14}}><div style={S.cardTitle}>{"Subject Averages — "+selClass+" — "+selTerm+" "+selSess}</div><CSSBarChart data={subAvgData} keys={["avg","male","female"]} colors={[NAVY,BLUE,BRONZE]} height={220} maxVal={100}/></div><div style={S.card}><div style={S.cardTitle}>Subject Breakdown — by Sex &amp; Boarding</div><div style={{overflowX:"auto"}}><table style={S.table}><thead><tr><th style={{...S.th,minWidth:130}}>Subject</th><th style={S.thC}>N</th><th style={{...S.thC,background:"#1e3a5f",color:"#fff"}}>Avg</th><th style={{...S.thC,background:NAVY,color:"#fff"}}>Male</th><th style={{...S.thC,background:BRONZE,color:"#fff"}}>Female</th><th style={{...S.thC,background:BLUE,color:"#fff"}}>Day</th><th style={{...S.thC,background:GREEN,color:"#fff"}}>Boarder</th><th style={S.thC}>High</th><th style={S.thC}>Low</th><th style={S.thC}>Pass%</th></tr></thead><tbody>{subjectAnalytics.map(function(s){var pr=s.count?Math.round(s.pass/s.count*100):0;return(<tr key={s.subject}><td style={{...S.td,fontWeight:600,fontSize:11}}>{s.subject}</td><td style={S.tdC}>{s.count}</td><td style={{...S.tdC,fontWeight:700,color:parseFloat(s.avg)>=50?C.success:C.danger}}>{s.avg||"—"}</td><td style={{...S.tdC,color:NAVY,fontWeight:600}}>{s.maleAvg||"—"}</td><td style={{...S.tdC,color:BRONZE,fontWeight:600}}>{s.femaleAvg||"—"}</td><td style={{...S.tdC,color:BLUE,fontWeight:600}}>{s.dayAvg||"—"}</td><td style={{...S.tdC,color:GREEN,fontWeight:600}}>{s.boarderAvg||"—"}</td><td style={{...S.tdC,color:C.success,fontWeight:700}}>{s.highest}</td><td style={{...S.tdC,color:C.danger,fontWeight:700}}>{s.lowest}</td><td style={S.td}><span style={S.badge(pr>=70?"green":pr>=50?"yellow":"red")}>{pr}%</span></td></tr>);})}</tbody></table></div></div></div>}
      </div>
    );
  }

  function renderClassResults(){
    return(
      <div>
        <div style={{...S.card,marginBottom:14}}>
          <div style={S.grid2}>
            <div><label style={S.label}>Session</label><select style={{...S.select,width:"100%"}} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>{SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
            <div><label style={S.label}>Term</label><select style={{...S.select,width:"100%"}} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>{TERMS.map(function(t){return <option key={t}>{t}</option>;})}</select></div>
          </div>
        </div>
        {classAvgData.length===0 ? <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:36}}>{"No results for "+selTerm+" "+selSess+" yet."}</div> : <div><div style={{...S.card,marginBottom:14}}><div style={S.cardTitle}>{"Class Averages — "+selTerm+" "+selSess}</div><CSSBarChart data={classAvgData} keys={["overall","male","female","day","boarder"]} colors={[NAVY,BLUE,BRONZE,TEAL,GREEN]} height={220} maxVal={100}/></div><div style={{...S.card,marginBottom:14}}><div style={S.cardTitle}>Class Results — Disaggregated</div><div style={{overflowX:"auto"}}><table style={S.table}><thead><tr><th style={S.th}>Class</th><th style={S.thC}>Enrolled</th><th style={S.thC}>w/Results</th><th style={{...S.thC,background:"#1e3a5f",color:"#fff"}}>Avg</th><th style={{...S.thC,background:NAVY,color:"#fff"}}>Male</th><th style={{...S.thC,background:BRONZE,color:"#fff"}}>Female</th><th style={{...S.thC,background:BLUE,color:"#fff"}}>Day</th><th style={{...S.thC,background:GREEN,color:"#fff"}}>Boarder</th><th style={S.thC}>Pass%</th></tr></thead><tbody>{classResultsOverall.map(function(c){return(<tr key={c.cls}><td style={{...S.td,fontWeight:700}}>{c.cls}</td><td style={S.tdC}>{c.enrolled}</td><td style={S.tdC}>{c.withResults||"—"}</td><td style={{...S.tdC,fontWeight:700,color:c.classAvg?(parseFloat(c.classAvg)>=50?C.success:C.danger):C.textMuted}}>{c.classAvg||"—"}</td><td style={{...S.tdC,color:NAVY,fontWeight:600}}>{c.maleAvg||"—"}</td><td style={{...S.tdC,color:BRONZE,fontWeight:600}}>{c.femaleAvg||"—"}</td><td style={{...S.tdC,color:BLUE,fontWeight:600}}>{c.dayAvg||"—"}</td><td style={{...S.tdC,color:GREEN,fontWeight:600}}>{c.boarderAvg||"—"}</td><td style={S.td}>{c.passRate!==null?<span style={S.badge(c.passRate>=70?"green":c.passRate>=50?"yellow":"red")}>{c.passRate}%</span>:"—"}</td></tr>);})}</tbody></table></div></div><div style={S.card}><div style={S.cardTitle}>Grade Distribution</div><div style={{overflowX:"auto"}}><table style={S.table}><thead><tr><th style={S.th}>Class</th>{["A1","B2","B3","C4","C5","C6","D7","E8","F9"].map(function(g){return <th key={g} style={S.thC}>{g}</th>;})}</tr></thead><tbody>{classResultsOverall.filter(function(c){return c.withResults>0;}).map(function(c){return(<tr key={c.cls}><td style={{...S.td,fontWeight:700}}>{c.cls}</td>{["A1","B2","B3","C4","C5","C6","D7","E8","F9"].map(function(g){var v=c.gradeBreakdown[g]||0;var col=["A1","B2","B3"].indexOf(g)>=0?C.success:["C4","C5","C6"].indexOf(g)>=0?C.warning:C.danger;return <td key={g} style={{...S.tdC,fontWeight:v>0?700:400,color:v>0?col:C.textMuted}}>{v||"—"}</td>;})}</tr>);})}</tbody></table></div></div></div>}
      </div>
    );
  }

  return(
    <div>
      <div style={{display:"flex",gap:4,marginBottom:16,flexWrap:"wrap",borderBottom:"2px solid "+C.border}}>
        {TABS.map(function(pair){
          var id=pair[0]; var label=pair[1];
          return <button key={id} onClick={function(){setTab(id);}} style={{...S.btn(tab===id?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 12px"}}>{label}</button>;
        })}
      </div>
      <div>
        {tab==="students" ? renderDemographics() : null}
        {tab==="enrolment" ? renderEnrolment() : null}
        {tab==="subjects" ? renderSubjects() : null}
        {tab==="classresults" ? renderClassResults() : null}
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════════════
// STUDENTS — Enhanced with passport, genotype, boarding type
// ══════════════════════════════════════════════════════
// Isolated from StudentsModule's table so typing in this form never
// re-renders the (potentially large, photo-heavy) student table below it.
function StudentFormModal({open,student,onSave,onClose}){
  const ef={surname:"",firstname:"",middlename:"",dob:"",gender:"Male",class:"JSS1",arm:"A",entryClass:"JSS1",entrySession:CURRENT_SESSION,parentName:"",parentPhone:"",parentEmail:"",address:"",religion:"Islam",bloodGroup:"O+",genotype:"AA",boardingType:"Day",phone:"",passport:"",active:true,examExtraMinutes:0};
  const [form,setForm]=useState(student?{...student}:ef);
  const passRef=useRef();

  useEffect(function(){
    if(open) setForm(student?{...student}:ef);
  },[open,student]);

  function handlePassport(e){
    const file=e.target.files[0];if(!file)return;
    if(file.size>41000)return alert("Passport photo must be under 40KB. Please compress and re-upload.");
    const reader=new FileReader();reader.onload=ev=>setForm(p=>({...p,passport:ev.target.result}));reader.readAsDataURL(file);
  }

  function handleSave(){
    if(!form.surname||!form.firstname)return alert("Surname and First Name required.");
    onSave(form);
  }

  return(
    <Modal open={open} onClose={onClose} title={student?"Edit Student Record":"Enrol New Student"} wide>
      <div style={{...S.row,gap:16,marginBottom:14,alignItems:"flex-start"}}>
        <div style={{flexShrink:0,textAlign:"center"}}>
          <div style={{width:72,height:72,borderRadius:6,border:`2px dashed ${C.border}`,overflow:"hidden",background:"#F9FAFB",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:6}}>
            {form.passport?<img src={form.passport} style={{width:"100%",height:"100%",objectFit:"cover"}} alt=""/>:<Icon name="students" size={28} color={C.border}/>}
          </div>
          <button style={{...S.btn("secondary"),fontSize:10,padding:"4px 8px"}} onClick={()=>passRef.current.click()}>Upload Passport</button>
          <div style={{fontSize:9,color:C.textMuted,marginTop:2}}>Max 40KB</div>
          <input ref={passRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePassport}/>
        </div>
        <div style={{flex:1}}>
          <div style={S.grid2}><FormField form={form} setForm={setForm} label="Surname" field="surname" required/><FormField form={form} setForm={setForm} label="First Name" field="firstname" required/></div>
          <div style={S.grid2}><FormField form={form} setForm={setForm} label="Middle Name" field="middlename"/><div style={{...S.formGroup,background:"#FEF3C7",borderRadius:8,padding:"6px 8px",border:"1px solid #F59E0B"}}><label style={{...S.label,color:"#92400E",fontWeight:800}}>📅 Date of Birth *</label><input type="date" style={{...S.input,borderColor:"#F59E0B"}} value={form.dob} onChange={function(e){setForm(function(p){return{...p,dob:e.target.value};});}}/><div style={{fontSize:9,color:"#92400E",marginTop:2}}>Required for age calculation, analytics &amp; clinic</div></div></div>
        </div>
      </div>
      <div style={S.grid3}><FormField form={form} setForm={setForm} label="Gender" field="gender" opts={["Male","Female"]}/><FormField form={form} setForm={setForm} label="Religion" field="religion" opts={["Islam","Christianity","Others"]}/><FormField form={form} setForm={setForm} label="Boarding Type" field="boardingType" opts={["Day","Boarder"]}/></div>
      <div style={S.grid4}><FormField form={form} setForm={setForm} label="Blood Group" field="bloodGroup" opts={["A+","A-","B+","B-","AB+","AB-","O+","O-"]}/><FormField form={form} setForm={setForm} label="Genotype" field="genotype" opts={["AA","AS","SS","AC","SC"]}/><FormField form={form} setForm={setForm} label="Class" field="class" opts={CLASSES}/><FormField form={form} setForm={setForm} label="Arm" field="arm" opts={ARMS}/></div>
      <div style={S.grid3}><FormField form={form} setForm={setForm} label="Entry Class" field="entryClass" opts={CLASSES}/><FormField form={form} setForm={setForm} label="Entry Session" field="entrySession" opts={SESSIONS}/><FormField form={form} setForm={setForm} label="Student Phone" field="phone"/></div>
      <div style={S.grid2}><FormField form={form} setForm={setForm} label="Parent/Guardian Name" field="parentName"/><FormField form={form} setForm={setForm} label="Parent Phone" field="parentPhone"/></div>
      <div style={S.grid2}><FormField form={form} setForm={setForm} label="Parent Email" field="parentEmail"/><div style={S.formGroup}><label style={S.label}>Home Address</label><input style={S.input} value={form.address} onChange={e=>setForm(p=>({...p,address:e.target.value}))}/></div></div>
      <div style={{...S.formGroup,background:"#EFF6FF",borderRadius:8,padding:"6px 8px",border:"1px solid #93C5FD",maxWidth:260}}>
        <label style={{...S.label,color:"#1D4ED8"}}>⏱ CBT Exam Extra Time (minutes)</label>
        <input type="number" min="0" style={S.input} value={form.examExtraMinutes||0} onChange={function(e){setForm(function(p){return{...p,examExtraMinutes:parseInt(e.target.value)||0};});}}/>
        <div style={{fontSize:9,color:"#1D4ED8",marginTop:2}}>Standing extra time added to every CBT exam this student takes (accommodation/SEN).</div>
      </div>
      <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={onClose}>Cancel</button><button style={S.btn()} onClick={handleSave}>{student?"Save Changes":"Enrol Student"}</button></div>
    </Modal>
  );
}

function StudentsModule({students,setStudents}){
  const [tab,setTab]=useState("list");
  const [search,setSearch]=useState("");
  const [fCls,setFCls]=useState("");
  const [fType,setFType]=useState("");
  const [showForm,setShowForm]=useState(false);
  const [editing,setEditing]=useState(null);
  const [viewStu,setViewStu]=useState(null);
  // Bulk enrolment state
  const [bulkClass,setBulkClass]=useState("JSS1");
  const [bulkArm,setBulkArm]=useState("A");
  const [bulkSession,setBulkSession]=useState(CURRENT_SESSION);
  const [bulkRows,setBulkRows]=useState(
    Array.from({length:15},function(_,i){return{id:"row"+i,surname:"",firstname:"",middlename:"",gender:"Male",dob:"",parentName:"",parentPhone:"",bloodGroup:"O+",genotype:"AA",religion:"Islam",boardingType:"Day"};})
  );
  const [editingStudent,setEditingStudent]=useState(null);

  const filtered=students.filter(s=>
    (!fCls||s.class===fCls)&&(!fType||s.boardingType===fType)&&
    (!search||`${s.surname} ${s.firstname} ${s.admissionNo}`.toLowerCase().includes(search.toLowerCase()))
  );

  function openAdd(){setEditingStudent(null);setEditing(null);setShowForm(true);}
  function openEdit(s){setEditingStudent(s);setEditing(s.id);setShowForm(true);}
  function handleFormSave(form){
    if(editing){setStudents(p=>p.map(s=>s.id===editing?{...form,id:editing}:s));}
    else{const yr=form.entrySession.split("/")[0];setStudents(p=>[...p,{...form,id:genId(),admissionNo:admNo(yr,students.length+1)}]);}
    setShowForm(false);
  }
  function deactivate(id){if(window.confirm("Mark student as graduated/exited?"))setStudents(p=>p.map(s=>s.id===id?{...s,active:false}:s));}

  function updateBulkRow(idx,field,value){
    setBulkRows(function(p){return p.map(function(r,i){return i===idx?{...r,[field]:value}:r;});});
  }

  function saveBulkEnrolment(){
    var valid = bulkRows.filter(function(r){return r.surname.trim()&&r.firstname.trim();});
    if(!valid.length) return alert("Please fill at least one student's surname and first name.");
    var yr = bulkSession.split("/")[0];
    var startSeq = students.length + 1;
    var newStudents = valid.map(function(r,i){
      return {
        ...r, id:genId(),
        admissionNo: admNo(yr, startSeq+i),
        class:bulkClass, arm:bulkArm,
        entryClass:bulkClass, entrySession:bulkSession,
        active:true, passport:""
      };
    });
    setStudents(function(p){return [...p,...newStudents];});
    setBulkRows(Array.from({length:15},function(_,i){return{id:"row"+i,surname:"",firstname:"",middlename:"",gender:"Male",dob:"",parentName:"",parentPhone:"",bloodGroup:"O+",genotype:"AA",religion:"Islam",boardingType:"Day"};}));
    alert(newStudents.length+" student(s) enrolled successfully into "+bulkClass+bulkArm+".");
    setTab("list");
  }

  function addBulkRow(){
    setBulkRows(function(p){return [...p,{id:"row"+Date.now(),surname:"",firstname:"",middlename:"",gender:"Male",dob:"",parentName:"",parentPhone:"",bloodGroup:"O+",genotype:"AA",religion:"Islam",boardingType:"Day"}];});
  }

  return(<div>
    {/* Tab switcher */}
    <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border}}>
      {[["list","👨‍🎓 Student List"],["bulk","📋 Bulk Enrolment"]].map(function(pair){
        return <button key={pair[0]} onClick={function(){setTab(pair[0]);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 14px"}}>{pair[1]}</button>;
      })}
    </div>

    {tab==="list" ? <div>
    <div style={{...S.row,marginBottom:12,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
      <div style={S.row}>
        <div style={{position:"relative"}}><span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)"}}><Icon name="search" size={13} color={C.textMuted}/></span><input style={{...S.input,paddingLeft:27,width:190}} placeholder="Search name/adm. no." value={search} onChange={e=>setSearch(e.target.value)}/></div>
        <select style={S.select} value={fCls} onChange={e=>setFCls(e.target.value)}><option value="">All Classes</option>{CLASSES.map(c=><option key={c}>{c}</option>)}</select>
        <select style={S.select} value={fType} onChange={e=>setFType(e.target.value)}><option value="">All Types</option><option>Day</option><option>Boarder</option></select>
      </div>
      <button style={S.btn()} onClick={openAdd}><span style={S.row}><Icon name="plus" size={13}/> Enrol Student</span></button>
    </div>
    <div style={{marginBottom:10}}>
      <TableActionBar
        title="Students List"
        columns={["Adm. No.","Full Name","Class","Type","Blood/Geno","Parent","Phone","Status"]}
        rows={filtered.map(s=>[s.admissionNo,`${s.surname} ${s.firstname} ${s.middlename||""}`.trim(),s.class+s.arm,s.boardingType,`${s.bloodGroup}/${s.genotype}`,s.parentName,s.parentPhone,s.active?"Active":"Exited"])}
      />
    </div>
    <div style={S.card}>
      <div style={{overflowX:"auto"}}>
      <table style={S.table}><thead><tr>{["Passport","Adm. No.","Full Name","Class","Type","Blood/Geno","Parent","Phone","Status","Actions"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
      <tbody>
        {filtered.length===0&&<tr><td colSpan={10} style={{...S.td,textAlign:"center",color:C.textMuted,padding:28}}>No students found.</td></tr>}
        {filtered.map(s=>(
          <tr key={s.id} style={{background:!s.active?"#FAFAFA":C.white}}>
            <td style={{...S.td,width:40}}>{s.passport?<img src={s.passport} alt="" style={{width:32,height:32,borderRadius:4,objectFit:"cover"}}/>:<div style={{width:32,height:32,borderRadius:4,background:C.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:C.textMuted}}>—</div>}</td>
            <td style={S.td}><span style={{fontFamily:"monospace",fontSize:10}}>{s.admissionNo}</span></td>
            <td style={S.td}><b>{s.surname}</b> {s.firstname} {s.middlename}</td>
            <td style={S.td}>{s.class}{s.arm}</td>
            <td style={S.td}><span style={S.badge(s.boardingType==="Boarder"?"blue":"green")}>{s.boardingType}</span></td>
            <td style={S.td}><span style={{fontSize:11}}>{s.bloodGroup} / {s.genotype}</span></td>
            <td style={S.td}>{s.parentName}</td>
            <td style={S.td}>{s.parentPhone}</td>
            <td style={S.td}><span style={S.badge(s.active?"green":"red")}>{s.active?"Active":"Exited"}</span></td>
            <td style={S.td}><div style={S.row}>
              <button style={{...S.btn("ghost"),padding:3}} onClick={()=>setViewStu(s)}><Icon name="eye" size={14} color={C.primary}/></button>
              <button style={{...S.btn("ghost"),padding:3}} onClick={()=>openEdit(s)}><Icon name="edit" size={14} color={C.gold}/></button>
              {s.active&&<button style={{...S.btn("ghost"),padding:3}} onClick={()=>deactivate(s.id)}><Icon name="trash" size={14} color={C.danger}/></button>}
            </div></td>
          </tr>
        ))}
      </tbody></table>
      </div>
    </div>

    <StudentFormModal open={showForm} student={editingStudent} onSave={handleFormSave} onClose={()=>setShowForm(false)}/>

    <Modal open={!!viewStu} onClose={()=>setViewStu(null)} title="Student Profile" wide>
      {viewStu&&<div>
        <div style={{background:C.primaryDark,borderRadius:8,padding:"14px 16px",marginBottom:14,...S.row,gap:14}}>
          {viewStu.passport?<img src={viewStu.passport} style={{width:56,height:56,borderRadius:6,objectFit:"cover",flexShrink:0}} alt=""/>:<div style={{width:56,height:56,borderRadius:6,background:"rgba(255,255,255,0.1)",flexShrink:0}}/>}
          <div>
            <div style={{fontSize:17,fontWeight:800,color:C.goldLight}}>{viewStu.surname} {viewStu.firstname} {viewStu.middlename}</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:3}}>{viewStu.admissionNo} · {viewStu.class}{viewStu.arm} · {viewStu.gender} · {viewStu.boardingType}</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",marginTop:2}}>Enrolled: {viewStu.entryClass} — {viewStu.entrySession}</div>
          </div>
        </div>
        <div style={S.grid2}>{[["DOB",formatDate(viewStu.dob)],["Blood Group",viewStu.bloodGroup],["Genotype",viewStu.genotype],["Religion",viewStu.religion],["Parent",viewStu.parentName],["Parent Phone",viewStu.parentPhone],["Email",viewStu.parentEmail||"—"],["Student Phone",viewStu.phone||"—"],["Address",viewStu.address],["Status",viewStu.active?"Active":"Exited"]].map(([k,v])=>(<div key={k} style={{marginBottom:8}}><div style={{fontSize:10,color:C.textMuted,fontWeight:600}}>{k}</div><div style={{fontSize:12,marginTop:1}}>{v}</div></div>))}</div>
      </div>}
    </Modal>
  </div> : null}

  {tab==="bulk" ? (
    <div>
      {/* Bulk config */}
      <div style={{...S.card,marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:12}}>📋 Bulk Enrolment — Fill the spreadsheet below</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
          <div style={S.formGroup}><label style={S.label}>Class</label><select style={S.select} value={bulkClass} onChange={function(e){setBulkClass(e.target.value);}}>{CLASSES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
          <div style={S.formGroup}><label style={S.label}>Arm</label><select style={S.select} value={bulkArm} onChange={function(e){setBulkArm(e.target.value);}}>{["A","B","C","D","E"].map(function(a){return <option key={a}>{a}</option>;})}</select></div>
          <div style={S.formGroup}><label style={S.label}>Entry Session</label><select style={S.select} value={bulkSession} onChange={function(e){setBulkSession(e.target.value);}}>{SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
          <div style={{fontSize:11,color:C.textMuted,alignSelf:"flex-end",paddingBottom:6}}>Enrol into: <b>{bulkClass}{bulkArm}</b> · Session: <b>{bulkSession}</b></div>
        </div>
        <div style={{fontSize:11,color:C.textMuted,marginTop:6}}>✏️ Fill surname and first name at minimum. Empty rows are skipped automatically.</div>
      </div>
      <div style={{...S.card,overflowX:"auto"}}>
        <table style={{...S.table,fontSize:11}}>
          <thead><tr>
            <th style={{...S.th,width:30}}>#</th>
            <th style={{...S.th,minWidth:110}}>Surname *</th>
            <th style={{...S.th,minWidth:110}}>First Name *</th>
            <th style={{...S.th,minWidth:90}}>Middle Name</th>
            <th style={{...S.th,minWidth:70}}>Gender</th>
            <th style={{...S.th,minWidth:110}}>Date of Birth</th>
            <th style={{...S.th,minWidth:70}}>Blood Grp</th>
            <th style={{...S.th,minWidth:70}}>Genotype</th>
            <th style={{...S.th,minWidth:70}}>Boarding</th>
            <th style={{...S.th,minWidth:70}}>Religion</th>
            <th style={{...S.th,minWidth:120}}>Parent Name</th>
            <th style={{...S.th,minWidth:110}}>Parent Phone</th>
          </tr></thead>
          <tbody>
            {bulkRows.map(function(row,idx){
              var hasData = row.surname.trim()||row.firstname.trim();
              return(
                <tr key={row.id} style={{background:hasData?"#F0FDF4":"#fff"}}>
                  <td style={{...S.tdC,color:C.textMuted,fontSize:10}}>{idx+1}</td>
                  <td style={S.td}><input style={{...S.input,padding:"2px 4px",fontSize:11,width:"100%"}} value={row.surname} onChange={function(e){updateBulkRow(idx,"surname",e.target.value);}} placeholder="Surname"/></td>
                  <td style={S.td}><input style={{...S.input,padding:"2px 4px",fontSize:11,width:"100%"}} value={row.firstname} onChange={function(e){updateBulkRow(idx,"firstname",e.target.value);}} placeholder="First name"/></td>
                  <td style={S.td}><input style={{...S.input,padding:"2px 4px",fontSize:11,width:"100%"}} value={row.middlename} onChange={function(e){updateBulkRow(idx,"middlename",e.target.value);}} placeholder="Middle name"/></td>
                  <td style={S.td}><select style={{...S.select,padding:"2px 4px",fontSize:11,width:"100%"}} value={row.gender} onChange={function(e){updateBulkRow(idx,"gender",e.target.value);}}><option>Male</option><option>Female</option></select></td>
                  <td style={S.td}><input type="date" style={{...S.input,padding:"2px 4px",fontSize:10,width:"100%"}} value={row.dob} onChange={function(e){updateBulkRow(idx,"dob",e.target.value);}}/></td>
                  <td style={S.td}><select style={{...S.select,padding:"2px 4px",fontSize:10,width:"100%"}} value={row.bloodGroup} onChange={function(e){updateBulkRow(idx,"bloodGroup",e.target.value);}}>{["O+","O-","A+","A-","B+","B-","AB+","AB-"].map(function(b){return <option key={b}>{b}</option>;})}</select></td>
                  <td style={S.td}><select style={{...S.select,padding:"2px 4px",fontSize:10,width:"100%"}} value={row.genotype} onChange={function(e){updateBulkRow(idx,"genotype",e.target.value);}}>{["AA","AS","AC","SS","SC"].map(function(g){return <option key={g}>{g}</option>;})}</select></td>
                  <td style={S.td}><select style={{...S.select,padding:"2px 4px",fontSize:10,width:"100%"}} value={row.boardingType} onChange={function(e){updateBulkRow(idx,"boardingType",e.target.value);}}><option>Day</option><option>Boarder</option></select></td>
                  <td style={S.td}><select style={{...S.select,padding:"2px 4px",fontSize:10,width:"100%"}} value={row.religion} onChange={function(e){updateBulkRow(idx,"religion",e.target.value);}}><option>Islam</option><option>Christianity</option><option>Traditional</option></select></td>
                  <td style={S.td}><input style={{...S.input,padding:"2px 4px",fontSize:11,width:"100%"}} value={row.parentName} onChange={function(e){updateBulkRow(idx,"parentName",e.target.value);}} placeholder="Parent/Guardian"/></td>
                  <td style={S.td}><input style={{...S.input,padding:"2px 4px",fontSize:11,width:"100%"}} value={row.parentPhone} onChange={function(e){updateBulkRow(idx,"parentPhone",e.target.value);}} placeholder="08012345678"/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{display:"flex",gap:10,justifyContent:"space-between",marginTop:14}}>
        <button style={S.btn("secondary")} onClick={addBulkRow}>+ Add More Rows</button>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <div style={{fontSize:11,color:C.textMuted}}>{bulkRows.filter(function(r){return r.surname.trim()&&r.firstname.trim();}).length} student(s) ready to enrol</div>
          <button style={{...S.btn(),padding:"10px 24px",fontSize:13}} onClick={saveBulkEnrolment}>✅ Enrol All into {bulkClass}{bulkArm}</button>
        </div>
      </div>
    </div>
  ) : null}

  </div>);
}

// ══════════════════════════════════════════════════════
// ATTENDANCE — Daily class marking, bulk select, consecutive absence flag
// ══════════════════════════════════════════════════════
function AttendanceModule({students,attendance,setAttendance,settings}){
  const [selCls,setSelCls]=useState("JSS1");
  const [selDate,setSelDate]=useState(today());
  const [selSess,setSelSess]=useState(CURRENT_SESSION);
  const [selTerm,setSelTerm]=useState(CURRENT_TERM);
  const [tab,setTab]=useState("daily");

  const classStudents=students.filter(s=>s.active&&s.class===selCls).sort((a,b)=>a.surname.localeCompare(b.surname));

  // Get today's records for this class
  const todayRecords=attendance.filter(a=>a.date===selDate&&a.class===selCls&&a.session===selSess&&a.term===selTerm);
  const statusMap={};todayRecords.forEach(a=>{statusMap[a.studentId]=a.present;});

  function markStudent(studentId,present){
    const exists=attendance.find(a=>a.studentId===studentId&&a.date===selDate&&a.session===selSess&&a.term===selTerm);
    if(exists){setAttendance(p=>p.map(a=>(a.studentId===studentId&&a.date===selDate&&a.session===selSess&&a.term===selTerm)?{...a,present}:a));}
    else{setAttendance(p=>[...p,{id:genId(),studentId,date:selDate,session:selSess,term:selTerm,class:selCls,present}]);}
  }
  function markAll(present){classStudents.forEach(s=>markStudent(s.id,present));}

  // Find students with 2+ consecutive absences
  function getConsecutiveAbsent(studentId){
    const sAtt=attendance.filter(a=>a.studentId===studentId&&a.session===selSess&&a.term===selTerm).sort((a,b)=>b.date.localeCompare(a.date));
    let streak=0;
    for(const a of sAtt){if(a.present===false)streak++;else break;}
    return streak;
  }

  const flagged=classStudents.filter(s=>{const streak=getConsecutiveAbsent(s.id);return streak>=2;});

  function sendAbsenceAlerts(){
    const adminPhone=settings.adminPhone;
    flagged.forEach(s=>{
      const msg=`Dear Parent of ${s.firstname} ${s.surname}, your ward has been absent for 2 or more consecutive school days. Please contact the school urgently. — ${SCHOOL_NAME}`;
      sendSMS(s.parentPhone, SMS_TEMPLATES.absenceAlert(s.firstname+" "+s.surname, today()), "Absence Alert");
    });
    // Also send to admin
    if(adminPhone&&flagged.length>0){
      const names=flagged.map(s=>`${s.surname} ${s.firstname} (${s.class}${s.arm}) — Parent: ${s.parentPhone}`).join("\n");
      sendSMS(adminPhone,`ATTENDANCE ALERT:\nThe following students have 2+ consecutive absences:\n${names}`,"Admin Alert");
    }
    alert("Absence alert sent to "+flagged.length+" parent(s)"+(adminPhone?(" and Admin ("+adminPhone+")"):"")+".\n\n[SMS API stub — connect Termii or Twilio to go live]");
  }

  // Summary stats per student for this term
  function getAttSummary(studentId){
    const recs=attendance.filter(a=>a.studentId===studentId&&a.session===selSess&&a.term===selTerm);
    const pres=recs.filter(a=>a.present).length;
    return{total:recs.length,present:pres,absent:recs.length-pres,pct:recs.length?Math.round((pres/recs.length)*100):0};
  }

  // Group attendance by date for report
  const allDates=[...new Set(attendance.filter(a=>a.class===selCls&&a.session===selSess&&a.term===selTerm).map(a=>a.date))].sort();

  return(<div>
    <div style={{...S.card,marginBottom:14}}>
      <div style={S.grid3}>
        <div><label style={S.label}>Class</label><select style={{...S.select,width:"100%"}} value={selCls} onChange={e=>setSelCls(e.target.value)}>{CLASSES.map(c=><option key={c}>{c}</option>)}</select></div>
        <div><label style={S.label}>Session</label><select style={{...S.select,width:"100%"}} value={selSess} onChange={e=>setSelSess(e.target.value)}>{SESSIONS.map(s=><option key={s}>{s}</option>)}</select></div>
        <div><label style={S.label}>Term</label><select style={{...S.select,width:"100%"}} value={selTerm} onChange={e=>setSelTerm(e.target.value)}>{TERMS.map(t=><option key={t}>{t}</option>)}</select></div>
      </div>
    </div>
    <Tabs tabs={[["daily","Daily Marking"],["register","Class Register"],["flags","Absence Flags"]]} active={tab} onChange={setTab}/>

    {tab==="daily"&&<div>
      <div style={{...S.row,marginBottom:12,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={S.row}>
          <label style={{...S.label,marginBottom:0,marginRight:4}}>Date:</label>
          <input type="date" style={{...S.input,width:160}} value={selDate} onChange={e=>setSelDate(e.target.value)}/>
          <span style={{fontSize:11,color:C.textMuted}}>{classStudents.length} students in {selCls}</span>
        </div>
        <div style={S.row}>
          <button style={S.btn("success")} onClick={()=>markAll(true)}>✓ Mark All Present</button>
          <button style={S.btn("danger")} onClick={()=>markAll(false)}>✗ Mark All Absent</button>
        </div>
      </div>
      {classStudents.length===0?<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No students in {selCls} yet.</div>:<div style={S.card}>
        <table style={S.table}><thead><tr><th style={S.th}>Student</th><th style={S.th}>Adm. No.</th><th style={S.thC}>Present</th><th style={S.thC}>Absent</th><th style={S.thC}>Today's Status</th></tr></thead>
        <tbody>{classStudents.map(s=>{const present=statusMap[s.id];return(
          <tr key={s.id} style={{background:present===false?C.dangerLight:present===true?"#F0FDF4":C.white}}>
            <td style={S.td}><b>{s.surname}</b> {s.firstname}</td>
            <td style={S.td}><span style={{fontFamily:"monospace",fontSize:10}}>{s.admissionNo}</span></td>
            <td style={S.tdC}><button style={S.attDot(present===true)} onClick={()=>markStudent(s.id,true)}>✓</button></td>
            <td style={S.tdC}><button style={S.attDot(present===false)} onClick={()=>markStudent(s.id,false)}>✗</button></td>
            <td style={S.tdC}>{present===undefined?<span style={S.badge("")}>Not Marked</span>:present?<span style={S.badge("green")}>Present</span>:<span style={S.badge("red")}>Absent</span>}</td>
          </tr>
        );})}
        </tbody></table>
      </div>}
    </div>}

    {tab==="register"&&<div>
      <div style={{...S.card,overflowX:"auto"}}>
        <div style={S.cardTitle}>Class Register — {selCls} | {selTerm} {selSess}</div>
        {classStudents.length===0?<div style={{textAlign:"center",color:C.textMuted,padding:24}}>No students.</div>:<>
        <div style={{marginBottom:10}}>
          <TableActionBar
            title={"Attendance Register - "+selCls+" - "+selTerm+" "+selSess}
            columns={["Student"].concat(allDates,["Present","Absent","%"])}
            rows={classStudents.map(function(s){
              var sum=getAttSummary(s.id);
              var dateCells=allDates.map(function(d){
                var rec=attendance.find(function(a){return a.studentId===s.id&&a.date===d;});
                return rec&&rec.present===true?"P":rec&&rec.present===false?"A":"–";
              });
              return [s.surname+" "+s.firstname].concat(dateCells,[sum.present,sum.absent,sum.pct+"%"]);
            })}
          />
        </div>
        <table style={{...S.table,fontSize:10}}>
          <thead><tr>
            <th style={{...S.th,minWidth:120}}>Student</th>
            {allDates.map(d=><th key={d} style={{...S.thC,minWidth:36,fontSize:9}}>{d.slice(8)}/{d.slice(5,7)}</th>)}
            <th style={{...S.thC,background:C.gold,color:C.primaryDark,minWidth:44}}>Present</th>
            <th style={{...S.thC,background:C.gold,color:C.primaryDark,minWidth:44}}>Absent</th>
            <th style={{...S.thC,background:C.gold,color:C.primaryDark,minWidth:44}}>%</th>
          </tr></thead>
          <tbody>{classStudents.map(s=>{
            const sum=getAttSummary(s.id);
            return(<tr key={s.id}>
              <td style={{...S.td,fontWeight:600,fontSize:11,whiteSpace:"nowrap"}}>{s.surname} {s.firstname}</td>
              {allDates.map(d=>{const rec=attendance.find(a=>a.studentId===s.id&&a.date===d);return(<td key={d} style={{...S.tdC,background:rec?.present===false?C.dangerLight:rec?.present===true?"#F0FDF4":"transparent",fontSize:11}}>{rec?.present===true?"✓":rec?.present===false?"✗":"–"}</td>);})}
              <td style={{...S.tdC,color:C.success,fontWeight:700}}>{sum.present}</td>
              <td style={{...S.tdC,color:C.danger,fontWeight:700}}>{sum.absent}</td>
              <td style={S.tdC}><span style={S.badge(sum.pct>=75?"green":sum.pct>=50?"yellow":"red")}>{sum.pct}%</span></td>
            </tr>);
          })}</tbody>
        </table>
        </>}
      </div>
    </div>}

    {tab==="flags"&&<div>
      <div style={{...S.card,border:`2px solid ${flagged.length>0?C.danger:C.success}`}}>
        <div style={{...S.cardTitle,color:flagged.length>0?C.danger:C.success}}>{flagged.length>0?`⚠ ${flagged.length} Student(s) with 2+ Consecutive Absences`:"✓ No consecutive absence flags"}</div>
        {flagged.length>0&&<>
          <table style={S.table}><thead><tr>{["Student","Class","Parent Phone","Consecutive Absent Days","Action"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>{flagged.map(s=>{const streak=getConsecutiveAbsent(s.id);return(
            <tr key={s.id} style={{background:C.dangerLight}}>
              <td style={{...S.td,fontWeight:600}}>{s.surname} {s.firstname}</td>
              <td style={S.tdC}>{s.class}{s.arm}</td>
              <td style={S.td}>{s.parentPhone}</td>
              <td style={{...S.tdC,fontWeight:700,color:C.danger}}>{streak} days</td>
              <td style={S.td}><SMSButton phone={s.parentPhone} message={`Dear Parent of ${s.firstname} ${s.surname}, your ward has been absent ${streak} consecutive days. Please contact school. — ${SCHOOL_NAME}`} label="Alert Parent"/></td>
            </tr>
          );})}
          </tbody></table>
          <div style={{marginTop:12}}>
            <button style={S.btn("danger")} onClick={sendAbsenceAlerts}>Send All Alerts + Notify Admin</button>
            <span style={{fontSize:10,color:C.textMuted,marginLeft:10}}>[SMS stub — connect Termii/Twilio to go live]</span>
          </div>
        </>}
      </div>
    </div>}
  </div>);
}

// ══════════════════════════════════════════════════════
// FEES MODULE — Color coded + SMS stubs + Expenditure + Summary
// ══════════════════════════════════════════════════════
function FeesModule({students,fees,setFees,expenditure,setExpenditure,settings,currentUser}){
  var _tab = useState("fees"); var tab = _tab[0]; var setTab = _tab[1];
  var _fSess = useState(CURRENT_SESSION); var fSess = _fSess[0]; var setFSess = _fSess[1];
  var _fTerm = useState(CURRENT_TERM); var fTerm = _fTerm[0]; var setFTerm = _fTerm[1];
  var _fCls = useState(""); var fCls = _fCls[0]; var setFCls = _fCls[1];
  var _fStu = useState(""); var fStu = _fStu[0]; var setFStu = _fStu[1];
  var _showForm = useState(false); var showForm = _showForm[0]; var setShowForm = _showForm[1];
  var _showExp = useState(false); var showExp = _showExp[0]; var setShowExp = _showExp[1];
  var _showReceipt = useState(null); var showReceipt = _showReceipt[0]; var setShowReceipt = _showReceipt[1];
  var _form = useState({studentId:"",class:"",session:CURRENT_SESSION,term:CURRENT_TERM,feeType:"School Fees",amount:15000,amountPaid:0,datePaid:today(),status:"Unpaid",receipt:""});
  var form = _form[0]; var setForm = _form[1];
  var _expForm = useState({date:today(),amount:"",category:"Maintenance",reason:"",recordedBy:(currentUser&&currentUser.name)||"Admin"});
  var expForm = _expForm[0]; var setExpForm = _expForm[1];

  var FEE_TYPES = ["School Fees","Development Levy","PTA Levy","Exam Fee","Uniform","Books","Transport","Boarding Fee","Extra Lessons","Others"];
  var EXP_CATS = ["Maintenance","Salaries","Utilities","Office Supplies","Events","Transportation","Food/Catering","Security","Others"];

  // Class students for the payment form
  var classStudentsForForm = form.class ? students.filter(function(s){return s.active&&s.class===form.class;}).sort(function(a,b){return (a.surname+a.firstname).localeCompare(b.surname+b.firstname);}) : [];

  // Filter fee records
  var filtered = fees.filter(function(f){
    var stu = students.find(function(s){return s.id===f.studentId;});
    var matchSess = f.session===fSess;
    var matchTerm = f.term===fTerm;
    var matchCls = !fCls || (stu&&stu.class===fCls);
    var matchStu = !fStu || f.studentId===fStu;
    return matchSess && matchTerm && matchCls && matchStu;
  });

  var tb = filtered.reduce(function(a,f){return a+(f.amount||0);},0);
  var tp = filtered.reduce(function(a,f){return a+(f.amountPaid||0);},0);
  var tbal = tb - tp;

  var classFeeStudents = fCls ? students.filter(function(s){return s.active&&s.class===fCls;}) : [];

  function genReceiptNo(){
    return "RCP"+String(fees.length+1).padStart(4,"0");
  }

  function saveFee(){
    if(!form.studentId) return alert("Please select a class and student.");
    if(!form.amount) return alert("Please enter the fee amount.");
    var paid = parseInt(form.amountPaid)||0;
    var total = parseInt(form.amount)||0;
    var status = paid===0?"Unpaid":paid>=total?"Paid":"Part-Payment";
    var rcpt = genReceiptNo();
    var stu = students.find(function(s){return s.id===form.studentId;});
    var rec = {...form, id:genId(), amountPaid:paid, amount:total, status:status, receipt:rcpt,
      studentName:stu?(stu.surname+" "+stu.firstname):"", paid:paid};
    setFees(function(p){return [...p, rec];});

    // Auto SMS
    if(stu&&stu.parentPhone){
      var bal = total-paid;
      if(status==="Paid"){
        sendSMS(stu.parentPhone, SMS_TEMPLATES.feeReceipt(stu.firstname+" "+stu.surname, paid, 0), "Fee Receipt");
      } else if(status==="Part-Payment"){
        sendSMS(stu.parentPhone, SMS_TEMPLATES.feeReceipt(stu.firstname+" "+stu.surname, paid, bal), "Part Payment Receipt");
      }
    }

    // Show receipt
    setShowReceipt({...rec, student:stu});
    setShowForm(false);
    setForm(function(p){return {...p, studentId:"", amountPaid:0, datePaid:today()};});
  }

  function saveExpenditure(){
    if(!expForm.amount||!expForm.reason) return alert("Amount and reason required.");
    setExpenditure(function(p){return [...p,{...expForm,id:genId(),amount:parseInt(expForm.amount)||0}];});
    setShowExp(false);
    setExpForm({date:today(),amount:"",category:"Maintenance",reason:"",recordedBy:(currentUser&&currentUser.name)||"Admin"});
  }

  function sendWeeklyReminders(){
    var unpaid = filtered.filter(function(f){return f.status!=="Paid";});
    unpaid.forEach(function(f){
      var stu = students.find(function(s){return s.id===f.studentId;});
      if(!stu) return;
      var bal = (f.amount||0)-(f.amountPaid||0);
      sendSMS(stu.parentPhone, SMS_TEMPLATES.feeReminder(stu.firstname+" "+stu.surname, bal), "Fee Reminder");
    });
    alert("Reminders sent to "+unpaid.length+" parent(s).");
  }

  function buildReceiptHtml(rec){
    var stu = rec.student || students.find(function(s){return s.id===rec.studentId;});
    var logo = settings&&settings.schoolLogo ? `<img src="${settings.schoolLogo}" style="width:70px;height:70px;object-fit:contain;" alt=""/>` : "";
    var stamp = settings&&settings.schoolStamp ? `<img src="${settings.schoolStamp}" style="height:60px;object-fit:contain;" alt=""/>` : `<div style="width:70px;height:70px;border:1px dashed #ccc;border-radius:50%;"></div>`;
    var sig = settings&&settings.signature ? `<img src="${settings.signature}" style="height:50px;object-fit:contain;" alt=""/>` : `<div style="width:120px;border-bottom:1px solid #000;height:50px;"></div>`;
    var total = rec.amount||0;
    var paid = rec.amountPaid||rec.paid||0;
    var bal = total-paid;
    var html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Receipt ${rec.receipt}</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;font-size:12px;padding:20px;max-width:600px;margin:0 auto;}
.header{display:flex;align-items:center;gap:12px;border-bottom:3px solid #8B0000;padding-bottom:12px;margin-bottom:12px;}
.school-name{font-size:18px;font-weight:900;color:#8B0000;}
.invoice-title{text-align:center;font-size:16px;font-weight:800;color:#8B0000;margin:12px 0;text-decoration:underline;}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;border:1px solid #ccc;padding:10px;}
.info-item{display:flex;flex-direction:column;gap:2px;}
.info-label{font-size:9px;color:#666;font-weight:700;text-transform:uppercase;}
.info-value{font-size:12px;font-weight:600;}
table{width:100%;border-collapse:collapse;margin-bottom:16px;}
th{background:#8B0000;color:#fff;padding:8px;text-align:left;font-size:11px;}
td{padding:8px;border:1px solid #eee;font-size:11px;}
.total-row{background:#F5F3FB;font-weight:700;}
.status-badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:700;
  background:${bal===0?"#D1FAE5":bal<total?"#FEF3C7":"#FEE2E2"};color:${bal===0?"#065F46":bal<total?"#92400E":"#991B1B"};}
.footer{display:flex;justify-content:space-between;align-items:flex-end;margin-top:20px;padding-top:16px;border-top:1px solid #ccc;}
.sig-box{text-align:center;}
.sig-label{font-size:9px;color:#666;margin-top:4px;}
@media print{body{padding:5mm;}}</style></head>
<body>
<div class="header">
  ${logo}
  <div>
    <div class="school-name">ASSANUSIYYAH GROUP OF SCHOOLS</div>
    <div style="font-size:10px;color:#555;">Learning, Moral And Religion</div>
    <div style="font-size:10px;color:#555;">P M B 2002, IPETUMODU ROAD, OKE YIDI, ODEOMU, OSUN STATE.</div>
    <div style="font-size:10px;color:#555;">Tel: 08039650771 | Email: safwatuadnan83@gmail.com</div>
  </div>
  <div style="margin-left:auto;text-align:right;">
    <div style="font-size:11px;font-weight:700;color:#8B0000;">RECEIPT NO.</div>
    <div style="font-size:20px;font-weight:900;color:#8B0000;">${rec.receipt}</div>
    <div style="font-size:10px;color:#555;">Date: ${rec.datePaid||today()}</div>
  </div>
</div>

<div class="invoice-title">OFFICIAL FEE RECEIPT / INVOICE</div>

<div class="info-grid">
  <div class="info-item"><span class="info-label">Student Name</span><span class="info-value">${stu?(stu.surname+" "+stu.firstname+" "+(stu.middlename||"")).trim():"—"}</span></div>
  <div class="info-item"><span class="info-label">Admission No.</span><span class="info-value">${stu?stu.admissionNo:"—"}</span></div>
  <div class="info-item"><span class="info-label">Class</span><span class="info-value">${stu?(stu.class+(stu.arm||"")):"—"}</span></div>
  <div class="info-item"><span class="info-label">Session / Term</span><span class="info-value">${rec.session} / ${rec.term}</span></div>
  <div class="info-item"><span class="info-label">Parent Phone</span><span class="info-value">${stu?stu.parentPhone:"—"}</span></div>
  <div class="info-item"><span class="info-label">Payment Status</span><span class="info-value"><span class="status-badge">${rec.status}</span></span></div>
</div>

<table>
  <thead><tr><th>Description</th><th>Amount Billed</th><th>Amount Paid</th><th>Balance</th></tr></thead>
  <tbody>
    <tr><td>${rec.feeType||"School Fees"}</td><td>₦${total.toLocaleString()}</td><td style="color:#065F46;font-weight:700;">₦${paid.toLocaleString()}</td><td style="color:${bal>0?"#991B1B":"#065F46"};font-weight:700;">₦${bal.toLocaleString()}</td></tr>
    <tr class="total-row"><td><b>TOTAL</b></td><td><b>₦${total.toLocaleString()}</b></td><td style="color:#065F46;"><b>₦${paid.toLocaleString()}</b></td><td style="color:${bal>0?"#991B1B":"#065F46"};"><b>₦${bal.toLocaleString()}</b></td></tr>
  </tbody>
</table>

${bal>0?`<div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:6px;padding:8px 12px;margin-bottom:16px;font-size:11px;"><b>Outstanding Balance:</b> ₦${bal.toLocaleString()} — Please complete payment promptly to avoid disruption.</div>`:""}

<div class="footer">
  <div class="sig-box">
    ${sig}
    <div class="sig-label">Bursar / Authorised Signatory</div>
  </div>
  <div style="text-align:center;">
    ${stamp}
    <div class="sig-label">Official School Stamp</div>
  </div>
</div>

<div style="text-align:center;margin-top:16px;font-size:9px;color:#888;">This is an official receipt of ${SCHOOL_NAME}. Please keep this for your records.</div>
</body></html>`;
    return html;
  }

  function printReceipt(rec){ printHtmlDoc(buildReceiptHtml(rec)); }
  async function downloadReceiptPDF(rec){
    try{ await downloadHtmlDocAsPDF(buildReceiptHtml(rec), "Receipt_"+rec.receipt); }
    catch(e){ alert("Could not generate PDF: "+e.message); }
  }
  async function shareReceipt(rec){
    try{ await shareHtmlDoc(buildReceiptHtml(rec), "Receipt_"+rec.receipt, "Fee Receipt "+rec.receipt); }
    catch(e){ alert("Could not share: "+e.message); }
  }

  // Totals for expenditure
  var totalExp = expenditure.filter(function(e){return e.date&&e.date.startsWith(fSess.split("/")[0]);}).reduce(function(a,e){return a+(e.amount||0);},0);

  return(
    <div>
      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border}}>
        {[["fees","💰 Fee Payments"],["expenditure","📤 Expenditure"],["summary","📊 Summary"]].map(function(pair){
          return <button key={pair[0]} onClick={function(){setTab(pair[0]);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 14px"}}>{pair[1]}</button>;
        })}
      </div>

      {/* ── FEES TAB ── */}
      {tab==="fees" ? (
        <div>
          {/* Filters */}
          <div style={{...S.card,marginBottom:14}}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <select style={S.select} value={fSess} onChange={function(e){setFSess(e.target.value);}}>
                  {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
                </select>
                <select style={S.select} value={fTerm} onChange={function(e){setFTerm(e.target.value);}}>
                  {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
                </select>
                <select style={S.select} value={fCls} onChange={function(e){setFCls(e.target.value);setFStu("");}}>
                  <option value="">All Classes</option>
                  {CLASSES.map(function(c){return <option key={c}>{c}</option>;})}
                </select>
                {fCls ? (
                  <select style={S.select} value={fStu} onChange={function(e){setFStu(e.target.value);}}>
                    <option value="">All Students</option>
                    {students.filter(function(s){return s.active&&s.class===fCls;}).sort(function(a,b){return (a.surname+a.firstname).localeCompare(b.surname+b.firstname);}).map(function(s){
                      return <option key={s.id} value={s.id}>{s.surname} {s.firstname}</option>;
                    })}
                  </select>
                ) : null}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={function(){setShowForm(true);}} style={S.btn()}>+ Record Payment</button>
                <button onClick={sendWeeklyReminders} style={S.btn("secondary")}>📱 Send Reminders</button>
              </div>
            </div>

            {/* Totals */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginTop:12}}>
              {[
                {l:"Total Billed",v:"₦"+tb.toLocaleString(),bg:"#EFF6FF"},
                {l:"Total Paid",v:"₦"+tp.toLocaleString(),bg:"#F0FDF4"},
                {l:"Outstanding",v:"₦"+tbal.toLocaleString(),bg:tbal>0?"#FEF2F2":"#F0FDF4"},
                {l:"Collection Rate",v:tb?Math.round(tp/tb*100)+"%":"0%",bg:"#F5F3FB"},
              ].map(function(s,i){
                return <div key={i} style={{...S.statCard(s.bg),padding:"10px 12px"}}><div style={S.statNum}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>;
              })}
            </div>
          </div>

          <div style={{marginBottom:10}}>
            <TableActionBar
              title={"Fee Records - "+fSess+" "+fTerm}
              columns={["Receipt","Student","Class","Fee Type","Billed","Paid","Balance","Status","Date"]}
              rows={filtered.map(function(f){
                var stu = students.find(function(s){return s.id===f.studentId;});
                var bal = (f.amount||0)-(f.amountPaid||0);
                return [f.receipt,stu?(stu.surname+" "+stu.firstname):"—",stu?(stu.class+(stu.arm||"")):"—",f.feeType||"School Fees",f.amount||0,f.amountPaid||0,bal,f.status,f.datePaid||""];
              })}
            />
          </div>

          {/* Fee records table */}
          <div style={S.card}>
            <div style={{overflowX:"auto"}}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {["Receipt","Student","Class","Fee Type","Billed","Paid","Balance","Status","Date","Actions"].map(function(h){
                      return <th key={h} style={S.th}>{h}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length===0 ? (
                    <tr><td colSpan={10} style={{...S.tdC,padding:32,color:C.textMuted}}>No fee records for this period.</td></tr>
                  ) : filtered.map(function(f){
                    var stu = students.find(function(s){return s.id===f.studentId;});
                    var bal = (f.amount||0)-(f.amountPaid||0);
                    return(
                      <tr key={f.id}>
                        <td style={{...S.td,fontSize:10,fontFamily:"monospace"}}>{f.receipt}</td>
                        <td style={{...S.td,fontWeight:600,minWidth:120}}>{stu?(stu.surname+" "+stu.firstname):"Unknown"}</td>
                        <td style={S.tdC}>{stu?(stu.class+(stu.arm||"")):"—"}</td>
                        <td style={S.td}>{f.feeType||"School Fees"}</td>
                        <td style={S.tdC}>₦{(f.amount||0).toLocaleString()}</td>
                        <td style={{...S.tdC,color:C.success,fontWeight:700}}>₦{(f.amountPaid||0).toLocaleString()}</td>
                        <td style={{...S.tdC,color:bal>0?C.danger:C.success,fontWeight:700}}>₦{bal.toLocaleString()}</td>
                        <td style={S.td}><span style={S.badge(f.status==="Paid"?"green":f.status==="Part-Payment"?"yellow":"red")}>{f.status}</span></td>
                        <td style={{...S.td,fontSize:10}}>{formatDate(f.datePaid||"")}</td>
                        <td style={S.td}>
                          <div style={{display:"flex",gap:4}}>
                            <button onClick={function(){printReceipt({...f,student:stu});}} style={{...S.btn("blue"),fontSize:10,padding:"2px 8px"}}>🖨</button>
                            <button onClick={function(){downloadReceiptPDF({...f,student:stu});}} style={{...S.btn("secondary"),fontSize:10,padding:"2px 8px"}}>📄 PDF</button>
                            <button onClick={function(){shareReceipt({...f,student:stu});}} style={{...S.btn("gold"),fontSize:10,padding:"2px 8px"}}>📤</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Record Payment Modal */}
          {showForm ? (
            <Modal open={showForm} onClose={function(){setShowForm(false);}} title="Record Fee Payment">
              <div style={S.grid2}>
                <div style={S.formGroup}>
                  <label style={S.label}>Session</label>
                  <select style={{...S.select,width:"100%"}} value={form.session} onChange={function(e){setForm(function(p){return{...p,session:e.target.value};});}}>
                    {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Term</label>
                  <select style={{...S.select,width:"100%"}} value={form.term} onChange={function(e){setForm(function(p){return{...p,term:e.target.value};});}}>
                    {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Class *</label>
                  <select style={{...S.select,width:"100%"}} value={form.class} onChange={function(e){setForm(function(p){return{...p,class:e.target.value,studentId:""};});}}>
                    <option value="">— Select Class —</option>
                    {CLASSES.map(function(c){return <option key={c}>{c}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Student Name *</label>
                  <select style={{...S.select,width:"100%"}} value={form.studentId} onChange={function(e){setForm(function(p){return{...p,studentId:e.target.value};});}}>
                    <option value="">— Select Student —</option>
                    {classStudentsForForm.map(function(s){
                      return <option key={s.id} value={s.id}>{s.surname} {s.firstname}</option>;
                    })}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Fee Type</label>
                  <select style={{...S.select,width:"100%"}} value={form.feeType} onChange={function(e){setForm(function(p){return{...p,feeType:e.target.value};});}}>
                    {FEE_TYPES.map(function(t){return <option key={t}>{t}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Date Paid</label>
                  <input type="date" style={S.input} value={form.datePaid} onChange={function(e){setForm(function(p){return{...p,datePaid:e.target.value};});}}/>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Amount Billed (₦)</label>
                  <input type="number" style={S.input} value={form.amount} onChange={function(e){setForm(function(p){return{...p,amount:e.target.value};});}} placeholder="e.g. 15000"/>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Amount Paid (₦)</label>
                  <input type="number" style={S.input} value={form.amountPaid} onChange={function(e){setForm(function(p){return{...p,amountPaid:e.target.value};});}} placeholder="e.g. 15000"/>
                </div>
              </div>
              {form.amount&&form.amountPaid ? (
                <div style={{background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:6,padding:"8px 12px",marginBottom:12,fontSize:12}}>
                  <b>Balance:</b> ₦{Math.max(0,(parseInt(form.amount)||0)-(parseInt(form.amountPaid)||0)).toLocaleString()}
                  {" "}<span style={S.badge((parseInt(form.amountPaid)||0)>=(parseInt(form.amount)||0)?"green":(parseInt(form.amountPaid)||0)>0?"yellow":"red")}>
                    {(parseInt(form.amountPaid)||0)>=(parseInt(form.amount)||0)?"Fully Paid":(parseInt(form.amountPaid)||0)>0?"Part-Payment":"Unpaid"}
                  </span>
                </div>
              ) : null}
              <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
                <button style={S.btn("secondary")} onClick={function(){setShowForm(false);}}>Cancel</button>
                <button style={S.btn()} onClick={saveFee}>Save & Generate Receipt</button>
              </div>
            </Modal>
          ) : null}

          {/* Receipt Modal */}
          {showReceipt ? (
            <Modal open={!!showReceipt} onClose={function(){setShowReceipt(null);}} title={"Receipt — "+showReceipt.receipt}>
              <div style={{textAlign:"center",marginBottom:16}}>
                <div style={{fontSize:16,fontWeight:700,color:C.success,marginBottom:4}}>✅ Payment Recorded!</div>
                <div style={{fontSize:12,color:C.textMuted}}>Receipt No: <b>{showReceipt.receipt}</b> · Status: <span style={S.badge(showReceipt.status==="Paid"?"green":showReceipt.status==="Part-Payment"?"yellow":"red")}>{showReceipt.status}</span></div>
              </div>
              <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
                <button style={S.btn()} onClick={function(){printReceipt(showReceipt);}}>🖨 Print Receipt</button>
                <button style={S.btn("blue")} onClick={function(){downloadReceiptPDF(showReceipt);}}>⬇ Download PDF</button>
                <button style={S.btn("gold")} onClick={function(){shareReceipt(showReceipt);}}>📤 Share</button>
                {showReceipt.student&&showReceipt.student.parentPhone ? (
                  <button style={S.btn("green")} onClick={function(){
                    var bal = (showReceipt.amount||0)-(showReceipt.amountPaid||0);
                    var msg = SCHOOL_NAME+" Fee Receipt\nStudent: "+showReceipt.student.surname+" "+showReceipt.student.firstname+"\nReceipt: "+showReceipt.receipt+"\nPaid: \u20a6"+(showReceipt.amountPaid||0).toLocaleString()+"\nBalance: \u20a6"+bal.toLocaleString()+"\nStatus: "+showReceipt.status;
                    window.open("https://wa.me/"+formatNGPhone(showReceipt.student.parentPhone).replace("+","")+"?text="+encodeURIComponent(msg),"_blank");
                  }}>📱 WhatsApp to Parent</button>
                ) : null}
                <button style={S.btn("secondary")} onClick={function(){setShowReceipt(null);}}>Close</button>
              </div>
            </Modal>
          ) : null}
        </div>
      ) : null}

      {/* ── EXPENDITURE TAB ── */}
      {tab==="expenditure" ? (
        <div>
          <div style={{...S.card,marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:13,fontWeight:700}}>Total Expenditure This Session: <span style={{color:C.danger}}>₦{totalExp.toLocaleString()}</span></div>
              <button onClick={function(){setShowExp(true);}} style={S.btn()}>+ Add Expenditure</button>
            </div>
          </div>
          <div style={S.card}>
            <table style={S.table}>
              <thead><tr>{["Date","Category","Reason","Amount","Recorded By"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
              <tbody>
                {expenditure.length===0 ? <tr><td colSpan={5} style={{...S.tdC,padding:32,color:C.textMuted}}>No expenditure records yet.</td></tr> :
                expenditure.sort(function(a,b){return b.date.localeCompare(a.date);}).map(function(e){
                  return(
                    <tr key={e.id}>
                      <td style={S.td}>{formatDate(e.date)}</td>
                      <td style={S.td}><span style={S.badge("yellow")}>{e.category}</span></td>
                      <td style={S.td}>{e.reason}</td>
                      <td style={{...S.tdC,fontWeight:700,color:C.danger}}>₦{(e.amount||0).toLocaleString()}</td>
                      <td style={S.td}>{e.recordedBy}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {showExp ? (
            <Modal open={showExp} onClose={function(){setShowExp(false);}} title="Record Expenditure">
              <div style={S.grid2}>
                <div style={S.formGroup}><label style={S.label}>Date</label><input type="date" style={S.input} value={expForm.date} onChange={function(e){setExpForm(function(p){return{...p,date:e.target.value};});}}/></div>
                <div style={S.formGroup}><label style={S.label}>Category</label><select style={{...S.select,width:"100%"}} value={expForm.category} onChange={function(e){setExpForm(function(p){return{...p,category:e.target.value};});}}>{EXP_CATS.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
                <div style={{...S.formGroup,gridColumn:"1/-1"}}><label style={S.label}>Reason / Description</label><input style={S.input} value={expForm.reason} onChange={function(e){setExpForm(function(p){return{...p,reason:e.target.value};});}} placeholder="What was the money used for?"/></div>
                <div style={S.formGroup}><label style={S.label}>Amount (₦)</label><input type="number" style={S.input} value={expForm.amount} onChange={function(e){setExpForm(function(p){return{...p,amount:e.target.value};});}} placeholder="0"/></div>
                <div style={S.formGroup}><label style={S.label}>Recorded By</label><input style={S.input} value={expForm.recordedBy} onChange={function(e){setExpForm(function(p){return{...p,recordedBy:e.target.value};});}}/></div>
              </div>
              <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:12}}>
                <button style={S.btn("secondary")} onClick={function(){setShowExp(false);}}>Cancel</button>
                <button style={S.btn()} onClick={saveExpenditure}>Save</button>
              </div>
            </Modal>
          ) : null}
        </div>
      ) : null}

      {/* ── SUMMARY TAB ── */}
      {tab==="summary" ? (
        <div>
          <div style={{...S.card,marginBottom:14}}>
            <div style={{display:"flex",gap:8}}>
              <select style={S.select} value={fSess} onChange={function(e){setFSess(e.target.value);}}>
                {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
              </select>
              <select style={S.select} value={fTerm} onChange={function(e){setFTerm(e.target.value);}}>
                {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
              </select>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:14}}>
            {CLASSES.map(function(cls){
              var clsFees = fees.filter(function(f){
                var stu = students.find(function(s){return s.id===f.studentId;});
                return f.session===fSess&&f.term===fTerm&&stu&&stu.class===cls;
              });
              var billed = clsFees.reduce(function(a,f){return a+(f.amount||0);},0);
              var paid = clsFees.reduce(function(a,f){return a+(f.amountPaid||0);},0);
              var pct = billed ? Math.round(paid/billed*100) : 0;
              return(
                <div key={cls} style={S.card}>
                  <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:8}}>{cls}</div>
                  <div style={{fontSize:11,color:C.textMuted,marginBottom:4}}>Billed: <b>₦{billed.toLocaleString()}</b></div>
                  <div style={{fontSize:11,color:C.success,marginBottom:6}}>Paid: <b>₦{paid.toLocaleString()}</b></div>
                  <div style={{height:8,background:"#F3F4F6",borderRadius:4,overflow:"hidden"}}>
                    <div style={{height:"100%",width:pct+"%",background:pct>=80?C.success:pct>=50?C.warning:C.danger,borderRadius:4}}/>
                  </div>
                  <div style={{fontSize:10,color:C.textMuted,marginTop:4}}>{pct}% collected · {clsFees.length} records</div>
                </div>
              );
            })}
          </div>
          <div style={{...S.card,marginTop:14}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700,padding:"6px 0",borderBottom:"2px solid "+C.border}}>
              <span>Total Billed ({fTerm} {fSess})</span>
              <span>₦{fees.filter(function(f){return f.session===fSess&&f.term===fTerm;}).reduce(function(a,f){return a+(f.amount||0);},0).toLocaleString()}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700,padding:"6px 0",borderBottom:"1px solid "+C.border,color:C.success}}>
              <span>Total Collected</span>
              <span>₦{fees.filter(function(f){return f.session===fSess&&f.term===fTerm;}).reduce(function(a,f){return a+(f.amountPaid||0);},0).toLocaleString()}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700,padding:"6px 0",color:C.danger}}>
              <span>Total Expenditure (Session)</span>
              <span>₦{totalExp.toLocaleString()}</span>
            </div>
          </div>
          <div style={{marginTop:14}}>
            <TableActionBar
              title={"Financial Statement - "+fTerm+" "+fSess}
              columns={["Class","Billed","Paid","Collection %","Records"]}
              rows={CLASSES.map(function(cls){
                var clsFees = fees.filter(function(f){
                  var stu = students.find(function(s){return s.id===f.studentId;});
                  return f.session===fSess&&f.term===fTerm&&stu&&stu.class===cls;
                });
                var billed = clsFees.reduce(function(a,f){return a+(f.amount||0);},0);
                var paid = clsFees.reduce(function(a,f){return a+(f.amountPaid||0);},0);
                var pct = billed ? Math.round(paid/billed*100) : 0;
                return [cls,billed,paid,pct+"%",clsFees.length];
              }).concat([
                ["TOTAL BILLED",fees.filter(function(f){return f.session===fSess&&f.term===fTerm;}).reduce(function(a,f){return a+(f.amount||0);},0),"","",""],
                ["TOTAL COLLECTED","",fees.filter(function(f){return f.session===fSess&&f.term===fTerm;}).reduce(function(a,f){return a+(f.amountPaid||0);},0),"",""],
                ["TOTAL EXPENDITURE (SESSION)","","","",totalExp]
              ])}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}


function ResultsModule({students, results, setResults, settings, staff, currentUser, classRemarks, setClassRemarks, assignments, setAssignments}){
  var _tab = useState("entry"); var tab = _tab[0]; var setTab = _tab[1];
  var _selClass = useState("JSS1"); var selClass = _selClass[0]; var setSelClass = _selClass[1];
  var _selArm = useState("A"); var selArm = _selArm[0]; var setSelArm = _selArm[1];
  var _selSub = useState(""); var selSub = _selSub[0]; var setSelSub = _selSub[1];
  var _selSess = useState(CURRENT_SESSION); var selSess = _selSess[0]; var setSelSess = _selSess[1];
  var _selTerm = useState(CURRENT_TERM); var selTerm = _selTerm[0]; var setSelTerm = _selTerm[1];
  var _viewStudent = useState(null); var viewStudent = _viewStudent[0]; var setViewStudent = _viewStudent[1];
  var _saved = useState(false); var saved = _saved[0]; var setSaved = _saved[1];
  var _nextTerm = useState(""); var nextTerm = _nextTerm[0]; var setNextTerm = _nextTerm[1];
  var _daysOpened = useState(""); var daysOpened = _daysOpened[0]; var setDaysOpened = _daysOpened[1];
  var _showRemedial = useState(false); var showRemedial = _showRemedial[0]; var setShowRemedial = _showRemedial[1];
  var _remedialAsnId = useState(""); var remedialAsnId = _remedialAsnId[0]; var setRemedialAsnId = _remedialAsnId[1];

  var isAdmin = currentUser.role==="root"||currentUser.role==="admin"||currentUser.role==="Admin";
  var ARMS = ["A","B","C","D","E"];
  var subjects = getSubjects(selClass);
  if(selSub==="") { var firstSub = subjects[0]||""; }
  var rc = getResultConfig(settings);
  var myStaffRec = staff.find(function(s){ return (s.surname+" "+s.firstname).toLowerCase()===currentUser.name.toLowerCase(); });
  var isPrincipal = isAdmin || (myStaffRec && String(myStaffRec.role||"").toLowerCase().indexOf("principal")!==-1);
  function isClassTeacherOf(cls){ return isAdmin || (myStaffRec && (myStaffRec.classes||[]).includes(cls)); }

  // Class students
  var classStudents = students.filter(function(s){
    return s.active && s.class===selClass && (s.arm||"A")===selArm;
  }).sort(function(a,b){ return (a.surname+a.firstname).localeCompare(b.surname+b.firstname); });

  // Get result for a student+subject
  function getResult(studentId, subject){
    return results.find(function(r){
      return r.studentId===studentId && r.subject===subject &&
        r.session===selSess && r.term===selTerm && r.class===selClass;
    });
  }

  // ── Below-pass-mark students for a subject, for the "assign remedial work" tool ──
  function getBelowPassMarkStudents(subject){
    return classStudents.filter(function(stu){
      var r = getResult(stu.id, subject);
      return r && (r.total||0) < rc.passMark;
    });
  }

  function assignRemedial(subject, assignmentId, belowIds){
    setAssignments(function(p){ return p.map(function(a){
      if(a.id!==assignmentId) return a;
      var merged = Array.from(new Set([...(a.targetStudentIds||[]), ...belowIds]));
      return {...a, targetStudentIds:merged};
    });});
    setShowRemedial(false);
    setRemedialAsnId("");
    alert("Assigned to "+belowIds.length+" below-pass-mark student(s).");
  }

  // Save/update a score field
  function setScore(studentId, subject, field, value){
    var fieldMax = field==="exam"?rc.examMax:field==="ca1"?rc.ca1Max:rc.ca2Max;
    var val = Math.min(parseInt(value)||0, fieldMax);
    var existing = getResult(studentId, subject);
    if(existing){
      setResults(function(p){ return p.map(function(r){
        if(r.id===existing.id){
          var updated = {...r, [field]:val};
          updated.total = (updated.ca1||0)+(updated.ca2||0)+(updated.exam||0);
          return updated;
        }
        return r;
      });});
    } else {
      var newR = {
        id:genId(), studentId:studentId, subject:subject,
        class:selClass, arm:selArm, session:selSess, term:selTerm,
        ca1:0, ca2:0, exam:0, total:0,
        affectiveTraits:{}, psychomotorSkills:{},
        teacherComment:"", formMasterComment:"", principalComment:"",
        [field]:val
      };
      newR.total = (newR.ca1||0)+(newR.ca2||0)+(newR.exam||0);
      setResults(function(p){ return [...p, newR]; });
    }
  }

  // Compute class statistics for a subject
  function getSubjectStats(subject){
    var subResults = results.filter(function(r){
      return r.subject===subject && r.session===selSess && r.term===selTerm && r.class===selClass;
    });
    if(!subResults.length) return {avg:0, highest:0, lowest:0, count:0};
    var totals = subResults.map(function(r){return r.total||0;});
    var avg = totals.reduce(function(a,b){return a+b;},0)/totals.length;
    return {
      avg: parseFloat(avg.toFixed(1)),
      highest: Math.max.apply(null,totals),
      lowest: Math.min.apply(null,totals),
      count: subResults.length
    };
  }

  // Compute student position in class for a subject
  function getSubjectPosition(studentId, subject){
    var subResults = results.filter(function(r){
      return r.subject===subject && r.session===selSess && r.term===selTerm && r.class===selClass;
    }).sort(function(a,b){return (b.total||0)-(a.total||0);});
    var pos = subResults.findIndex(function(r){return r.studentId===studentId;});
    return pos>=0 ? pos+1 : "-";
  }

  // Weighted score = (student score / class highest) * 100
  function getWeightedScore(score, highest){
    if(!highest) return 0;
    return parseFloat(((score/highest)*100).toFixed(1));
  }

  // Get student overall stats across all subjects
  function getStudentStats(studentId){
    var stuResults = results.filter(function(r){
      return r.studentId===studentId && r.session===selSess && r.term===selTerm && r.class===selClass;
    });
    if(!stuResults.length) return null;
    var total = stuResults.reduce(function(a,r){return a+(r.total||0);},0);
    var avg = total/stuResults.length;

    // Position in class (by average)
    var allStudentAvgs = classStudents.map(function(s){
      var sr = results.filter(function(r){
        return r.studentId===s.id && r.session===selSess && r.term===selTerm && r.class===selClass;
      });
      var t = sr.reduce(function(a,r){return a+(r.total||0);},0);
      return {id:s.id, avg: sr.length ? t/sr.length : 0};
    }).sort(function(a,b){return b.avg-a.avg;});

    var classPos = allStudentAvgs.findIndex(function(s){return s.id===studentId;})+1;
    var classAvg = allStudentAvgs.reduce(function(a,s){return a+s.avg;},0)/allStudentAvgs.length;
    var classHighest = allStudentAvgs.length ? allStudentAvgs[0].avg : 0;
    var classLowest = allStudentAvgs.length ? allStudentAvgs[allStudentAvgs.length-1].avg : 0;

    return {
      totalScore: total,
      avg: parseFloat(avg.toFixed(2)),
      position: classPos,
      classAvg: parseFloat(classAvg.toFixed(2)),
      classHighest: parseFloat(classHighest.toFixed(2)),
      classLowest: parseFloat(classLowest.toFixed(2)),
      subjectCount: stuResults.length
    };
  }

  var AFFECTIVE_TRAITS = [
    "Punctuality","Mental Alertness","Behavior","Reliability","Attentiveness",
    "Respect","Neatness","Politeness","Honesty","Relationship with staff",
    "Relationship with students","Attitude to school","Self-control",
    "Spirit of teamwork","Initiatives","Organizational ability"
  ];
  var PSYCHOMOTOR_SKILLS = [
    "Handwriting","Reading","Verbal fluency/Diction","Musical Skills",
    "Creative arts","Physical education","General reasoning"
  ];
  var RATING_KEY = [
    {v:5,m:"Maintains an excellent degree of observation"},
    {v:4,m:"Maintains high level of observation trait"},
    {v:3,m:"Acceptable level of observation trait"},
    {v:2,m:"Shows minimal level of observation trait"},
    {v:1,m:"Has no regard for observation trait"},
  ];

  function ordinal(n){
    if(!n||n==="-") return "-";
    var s=["th","st","nd","rd"];
    var v=n%100;
    return n+(s[(v-20)%10]||s[v]||s[0]);
  }

  // Update affective/psychomotor rating
  function setRating(studentId, field, trait, value){
    var stuResults = results.filter(function(r){
      return r.studentId===studentId && r.session===selSess && r.term===selTerm && r.class===selClass;
    });
    if(!stuResults.length) return;
    // Update all results for this student (store on first subject result)
    var firstId = stuResults[0].id;
    setResults(function(p){ return p.map(function(r){
      if(r.id===firstId){
        var updated = {...r};
        if(field==="affective") updated.affectiveTraits = {...(r.affectiveTraits||{}), [trait]:value};
        if(field==="psychomotor") updated.psychomotorSkills = {...(r.psychomotorSkills||{}), [trait]:value};
        return updated;
      }
      return r;
    });});
  }

  function setComment(studentId, field, value){
    var stuResults = results.filter(function(r){
      return r.studentId===studentId && r.session===selSess && r.term===selTerm && r.class===selClass;
    });
    if(!stuResults.length) return;
    var firstId = stuResults[0].id;
    setResults(function(p){ return p.map(function(r){
      if(r.id===firstId){
        var updated = {...r, [field]:value};
        return updated;
      }
      return r;
    });});
  }

  function getStudentMeta(studentId){
    var sr = results.find(function(r){
      return r.studentId===studentId && r.session===selSess && r.term===selTerm && r.class===selClass;
    });
    return sr || {};
  }

  // ── General class remark (not tied to a specific student) ─────
  function getClassRemark(cls, arm, sess, term){
    var s = sess||selSess, t = term||selTerm;
    return (classRemarks||[]).find(function(cr){
      return cr.class===cls && cr.arm===arm && cr.session===s && cr.term===t;
    }) || {teacherRemark:"", principalRemark:""};
  }

  function setClassRemarkField(field, value){
    var existing = (classRemarks||[]).find(function(cr){
      return cr.class===selClass && cr.arm===selArm && cr.session===selSess && cr.term===selTerm;
    });
    if(existing){
      setClassRemarks(function(p){ return p.map(function(cr){
        return cr.id===existing.id ? {...cr, [field]:value, updatedBy:currentUser.name, updatedAt:today()} : cr;
      });});
    } else {
      setClassRemarks(function(p){ return [...p, {
        id:genId(), class:selClass, arm:selArm, session:selSess, term:selTerm,
        teacherRemark:"", principalRemark:"", [field]:value,
        updatedBy:currentUser.name, updatedAt:today()
      }];});
    }
  }

  // ── PRINT SINGLE REPORT CARD ──────────────────────
  function printReportCard(student){
    var stats = getStudentStats(student.id);
    var meta = getStudentMeta(student.id);
    var classRemark = getClassRemark(student.class, student.arm||selArm, selSess, selTerm);
    var stuResults = results.filter(function(r){
      return r.studentId===student.id && r.session===selSess && r.term===selTerm && r.class===selClass;
    });
    var logo = settings&&settings.schoolLogo ? settings.schoolLogo : "";
    var stamp = settings&&settings.schoolStamp ? settings.schoolStamp : "";
    var sig = settings&&settings.signature ? settings.signature : "";
    var totalMax = rc.ca1Max+rc.ca2Max+rc.examMax;

    var subjectRows = subjects.map(function(sub){
      var r = stuResults.find(function(x){return x.subject===sub;});
      if(!r) return null;
      var stats2 = getSubjectStats(sub);
      var pos = getSubjectPosition(student.id, sub);
      var grade = getGrade(r.total||0, settings);
      var weighted = getWeightedScore(r.total||0, stats2.highest);
      return {sub,r,stats2,pos,grade,weighted};
    }).filter(Boolean);

    var html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Report Card - ${student.surname} ${student.firstname}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:Arial,sans-serif;font-size:11px;color:#000;background:#fff;}
  .page{width:210mm;min-height:297mm;padding:8mm;margin:0 auto;}
  .header{display:flex;align-items:center;gap:10px;border-bottom:3px solid #8B0000;padding-bottom:8px;margin-bottom:8px;}
  .header img{width:70px;height:70px;object-fit:contain;}
  .header-text{flex:1;text-align:center;}
  .school-name{font-size:22px;font-weight:900;color:#8B0000;letter-spacing:1px;}
  .school-motto{font-size:11px;color:#444;margin:2px 0;}
  .school-address{font-size:10px;color:#555;}
  .exam-title{text-align:center;font-size:14px;font-weight:800;margin:6px 0;text-decoration:underline;color:#8B0000;}
  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px;border:1px solid #ccc;padding:6px;}
  .info-row{display:flex;gap:4px;font-size:10px;}
  .info-label{font-weight:700;min-width:80px;}
  .stats-box{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #8B0000;margin-bottom:6px;}
  .stats-col{padding:4px 6px;}
  .stats-item{display:flex;justify-content:space-between;font-size:9.5px;padding:1px 0;border-bottom:1px solid #eee;}
  .stats-item:last-child{border-bottom:none;}
  .stats-label{color:#333;}
  .stats-value{font-weight:700;color:#8B0000;}
  table{width:100%;border-collapse:collapse;margin-bottom:6px;}
  th{background:#8B0000;color:#fff;padding:4px 3px;font-size:9px;text-align:center;border:1px solid #8B0000;}
  td{padding:3px;font-size:9px;border:1px solid #ccc;text-align:center;}
  td.subject-name{text-align:left;font-weight:600;}
  .grade-A{color:#006600;font-weight:700;}
  .grade-B{color:#004080;font-weight:700;}
  .grade-C{color:#806000;font-weight:700;}
  .grade-D,.grade-E,.grade-F{color:#800000;font-weight:700;}
  .bottom-section{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:6px;}
  .affective-box{border:1px solid #8B0000;}
  .affective-header{background:#8B0000;color:#fff;padding:3px 5px;font-size:9px;font-weight:700;}
  .affective-row{display:flex;justify-content:space-between;padding:2px 5px;border-bottom:1px solid #eee;font-size:8.5px;}
  .score-range-box{border:1px solid #8B0000;}
  .range-row{display:flex;justify-content:space-between;padding:2px 4px;border-bottom:1px solid #eee;font-size:8px;}
  .key-box{border:1px solid #8B0000;}
  .key-row{display:flex;gap:4px;padding:2px 4px;border-bottom:1px solid #eee;font-size:8px;}
  .comment-section{margin-top:6px;}
  .comment-box{border:1px solid #ccc;padding:4px 6px;min-height:24px;margin-bottom:4px;}
  .comment-label{font-weight:700;font-size:9px;margin-bottom:2px;}
  .signature-row{display:flex;justify-content:space-between;margin-top:8px;align-items:flex-end;}
  .sig-box{text-align:center;min-width:120px;}
  .sig-line{border-top:1px solid #000;margin-top:4px;padding-top:2px;font-size:9px;}
  @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
</style></head><body><div class="page">

  <div class="header">
    ${logo ? `<img src="${logo}" alt="Logo"/>` : `<div style="width:70px;height:70px;border:2px solid #8B0000;display:flex;align-items:center;justify-content:center;font-weight:900;color:#8B0000;font-size:18px;">AS</div>`}
    <div class="header-text">
      <div class="school-name">ASSANUSIYYAH GROUP OF SCHOOLS</div>
      <div class="school-motto">Learning, Moral And Religion</div>
      <div class="school-address">Address: P M B 2002, IPETUMODU ROAD, OKE YIDI, ODEOMU, OSUN STATE.</div>
      <div class="school-address">Phone No: 08039650771 &nbsp;|&nbsp; Email: safwatuadnan83@gmail.com</div>
    </div>
    ${logo ? `<img src="${logo}" alt="Logo"/>` : `<div style="width:70px;height:70px;border:2px solid #8B0000;display:flex;align-items:center;justify-content:center;font-weight:900;color:#8B0000;font-size:18px;">AS</div>`}
  </div>

  <div class="exam-title">${selTerm.toUpperCase()} EXAMINATION</div>

  <div class="info-grid">
    <div>
      <div class="info-row"><span class="info-label">Session:</span><span>${selSess}/${selTerm.replace(" Term","")}</span></div>
      <div class="info-row"><span class="info-label">Name of student:</span><b>${student.surname} ${student.firstname} ${student.middlename||""}</b></div>
      <div class="info-row"><span class="info-label">Class:</span><span>${student.class}${student.arm||""}</span></div>
    </div>
    <div>
      <div class="info-row"><span class="info-label">Term:</span><span>${selTerm.replace(" Term","")}</span></div>
      <div class="info-row"><span class="info-label">Reg. No:</span><span>${student.admissionNo||""}</span></div>
      <div class="info-row"><span class="info-label">Next term begins:</span><span>${nextTerm||"_______________"}</span></div>
    </div>
  </div>

  <div class="stats-box">
    <div class="stats-col">
      ${rc.showPosition?`<div class="stats-item"><span class="stats-label">Position in entire class</span><span class="stats-value">${stats ? ordinal(stats.position) : "-"}</span></div>`:""}
      <div class="stats-item"><span class="stats-label">Overall total score</span><span class="stats-value">${stats ? stats.totalScore : "-"}</span></div>
      <div class="stats-item"><span class="stats-label">Student's average score</span><span class="stats-value">${stats ? stats.avg : "-"}</span></div>
      ${rc.showClassAverage?`<div class="stats-item"><span class="stats-label">Highest average in class</span><span class="stats-value">${stats ? stats.classHighest : "-"}</span></div>`:""}
    </div>
    <div class="stats-col">
      <div class="stats-item"><span class="stats-label">No. of students in class</span><span class="stats-value">${classStudents.length}</span></div>
      ${rc.showClassAverage?`<div class="stats-item"><span class="stats-label">Class average score</span><span class="stats-value">${stats ? stats.classAvg : "-"}</span></div>
      <div class="stats-item"><span class="stats-label">Lowest average in class</span><span class="stats-value">${stats ? stats.classLowest : "-"}</span></div>`:""}
      <div class="stats-item"><span class="stats-label">No. of days school opened</span><span class="stats-value">${daysOpened||"-"}</span></div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="text-align:left;min-width:100px;">SUBJECT</th>
        <th>TEST 1<br/>(${rc.ca1Max})</th>
        <th>TEST 2<br/>(${rc.ca2Max})</th>
        <th>EXAM<br/>(${rc.examMax})</th>
        <th>TOTAL<br/>(${totalMax})</th>
        <th>GRADE</th>
        ${rc.showPosition?"<th>SUBJECT<br/>POSITION</th>":""}
        ${rc.showClassAverage?"<th>CLASS<br/>AVERAGE</th><th>WEIGHTED<br/>SCORE</th><th>HIGHEST<br/>IN CLASS</th><th>LOWEST<br/>IN CLASS</th>":""}
        <th>REMARK</th>
      </tr>
    </thead>
    <tbody>
      ${subjectRows.map(function(row){
        var gc = row.grade.grade.startsWith("A")?"grade-A":row.grade.grade.startsWith("B")?"grade-B":row.grade.grade.startsWith("C")?"grade-C":"grade-F";
        return `<tr>
          <td class="subject-name">${row.sub}</td>
          <td>${row.r.ca1||"-"}</td>
          <td>${row.r.ca2||"-"}</td>
          <td>${row.r.exam||"-"}</td>
          <td style="font-weight:700;">${row.r.total||"-"}</td>
          <td class="${gc}">${row.grade.grade}</td>
          ${rc.showPosition?`<td>${ordinal(row.pos)}</td>`:""}
          ${rc.showClassAverage?`<td>${row.stats2.avg}</td><td>${row.weighted}</td><td style="color:#006600;font-weight:700;">${row.stats2.highest}</td><td style="color:#800000;font-weight:700;">${row.stats2.lowest}</td>`:""}
          <td style="color:${row.r.total>=70?"#006600":row.r.total>=50?"#806000":"#800000"};font-weight:600;">${row.grade.remark}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>

  ${(rc.showAffectiveTraits||rc.showPsychomotorSkills)?`<div class="bottom-section">
    ${rc.showAffectiveTraits?`<div>
      <div class="affective-box" style="margin-bottom:4px;">
        <div class="affective-header">AFFECTIVE TRAITS</div>
        ${AFFECTIVE_TRAITS.slice(0,8).map(function(t){
          var rating = (meta.affectiveTraits||{})[t]||"";
          return `<div class="affective-row"><span>${t}</span><span style="font-weight:700;">${rating}</span></div>`;
        }).join("")}
      </div>
      <div class="affective-box">
        <div class="affective-header">AFFECTIVE TRAITS (cont.)</div>
        ${AFFECTIVE_TRAITS.slice(8).map(function(t){
          var rating = (meta.affectiveTraits||{})[t]||"";
          return `<div class="affective-row"><span>${t}</span><span style="font-weight:700;">${rating}</span></div>`;
        }).join("")}
      </div>
    </div>`:""}
    <div>
      ${rc.showPsychomotorSkills?`<div class="affective-box" style="margin-bottom:4px;">
        <div class="affective-header">PSYCHOMOTOR SKILLS</div>
        ${PSYCHOMOTOR_SKILLS.map(function(t){
          var rating = (meta.psychomotorSkills||{})[t]||"";
          return `<div class="affective-row"><span>${t}</span><span style="font-weight:700;">${rating}</span></div>`;
        }).join("")}
      </div>`:""}
      <div class="score-range-box">
        <div class="affective-header">SCORE RANGE</div>
        ${[["0%-30%","F","Fail"],["30%-40%","E","Poor"],["40%-50%","D","Pass"],["50%-60%","C","Good"],["60%-70%","B","Very good"],["70%-100%","A","Excellent"]].map(function(row){
          return `<div class="range-row"><span>${row[0]}</span><span style="font-weight:700;">${row[1]}</span><span>${row[2]}</span></div>`;
        }).join("")}
      </div>
    </div>
    <div>
      <div class="key-box">
        <div class="affective-header">KEY &nbsp;&nbsp; MEANING</div>
        ${RATING_KEY.map(function(k){
          return `<div class="key-row"><span style="font-weight:700;min-width:12px;">${k.v}</span><span>${k.m}</span></div>`;
        }).join("")}
      </div>
    </div>
  </div>`:""}

  ${rc.showComments?`<div class="comment-section">
    <div class="comment-label">Class Teacher's comment:</div>
    <div class="comment-box">${meta.teacherComment||""}</div>
    <div class="comment-label">Form Master's report:</div>
    <div class="comment-box">${meta.formMasterComment||""}</div>
    <div class="comment-label">Principal's report:</div>
    <div class="comment-box">${meta.principalComment||""}</div>
    ${classRemark.teacherRemark?`<div class="comment-label">Class Teacher's General Remark (whole class):</div><div class="comment-box">${classRemark.teacherRemark}</div>`:""}
    ${classRemark.principalRemark?`<div class="comment-label">Principal's General Remark (whole class):</div><div class="comment-box">${classRemark.principalRemark}</div>`:""}
  </div>`:""}

  <div class="signature-row">
    <div class="sig-box">
      ${stamp ? `<img src="${stamp}" style="height:60px;object-fit:contain;"/>` : `<div style="height:60px;border:1px dashed #ccc;display:flex;align-items:center;justify-content:center;color:#999;font-size:9px;">School Stamp</div>`}
      <div class="sig-line">School Stamp</div>
    </div>
    <div class="sig-box">
      ${sig ? `<img src="${sig}" style="height:60px;object-fit:contain;"/>` : `<div style="height:60px;border:1px dashed #ccc;display:flex;align-items:center;justify-content:center;color:#999;font-size:9px;">Signature</div>`}
      <div class="sig-line">Principal's Signature</div>
    </div>
  </div>

</div></body></html>`;
    return html;
  }

  function openPrint(student){
    var html = printReportCard(student);
    var w = window.open("","_blank");
    if(w){ w.document.write(html); w.document.close(); w.print(); }
  }

  async function downloadPDF(student){
    var html = printReportCard(student);
    try{ await downloadHtmlDocAsPDF(html, student.surname+"_"+student.firstname+"_Report_"+selTerm+"_"+selSess); }
    catch(e){ alert("Could not generate PDF: "+e.message); }
  }

  async function shareReportCard(student){
    var html = printReportCard(student);
    try{ await shareHtmlDoc(html, student.surname+"_"+student.firstname+"_Report_"+selTerm+"_"+selSess, "Report Card — "+student.surname+" "+student.firstname); }
    catch(e){ alert("Could not share: "+e.message); }
  }

  function shareWhatsApp(student){
    var stats = getStudentStats(student.id);
    var msg = "ASSANUSIYYAH GROUP OF SCHOOLS\n"+selTerm+" "+selSess+" Result\n\n"+
      "Student: "+student.surname+" "+student.firstname+"\n"+
      "Class: "+student.class+(student.arm||"")+"\n"+
      "Average: "+(stats?stats.avg:"-")+"%\n"+
      "Position: "+(stats?ordinal(stats.position):"-")+" of "+classStudents.length+"\n\n"+
      "For full result visit: grand-sprinkles-8cf60c.netlify.app";
    window.open("https://wa.me/"+formatNGPhone(student.parentPhone).replace("+","")+"?text="+encodeURIComponent(msg),"_blank");
  }

  function bulkPrint(){
    var allHtml = classStudents.map(function(s){
      return printReportCard(s);
    }).join('<div style="page-break-after:always;"></div>');
    var w = window.open("","_blank");
    if(w){ w.document.write(allHtml); w.document.close(); w.print(); }
  }

  // ── ENTRY TAB RENDER ─────────────────────────────
  function renderEntry(){
    var currentSub = selSub || subjects[0] || "";
    var subStats = getSubjectStats(currentSub);
    return(
      <div>
        {/* Filters */}
        <div style={{...S.card,marginBottom:14}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
            <div style={S.formGroup}>
              <label style={S.label}>Session</label>
              <select style={S.select} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>
                {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
              </select>
            </div>
            <div style={S.formGroup}>
              <label style={S.label}>Term</label>
              <select style={S.select} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>
                {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
              </select>
            </div>
            <div style={S.formGroup}>
              <label style={S.label}>Class</label>
              <select style={S.select} value={selClass} onChange={function(e){setSelClass(e.target.value);setSelSub("");}}>
                {CLASSES.map(function(c){return <option key={c}>{c}</option>;})}
              </select>
            </div>
            <div style={S.formGroup}>
              <label style={S.label}>Arm</label>
              <select style={S.select} value={selArm} onChange={function(e){setSelArm(e.target.value);}}>
                {ARMS.map(function(a){return <option key={a}>{a}</option>;})}
              </select>
            </div>
            <div style={S.formGroup}>
              <label style={S.label}>Subject</label>
              <select style={S.select} value={currentSub} onChange={function(e){setSelSub(e.target.value);}}>
                {subjects.map(function(s){return <option key={s}>{s}</option>;})}
              </select>
            </div>
          </div>
          <div style={{fontSize:11,color:C.textMuted,marginTop:6}}>
            {classStudents.length} students in {selClass}{selArm} · Class avg: <b>{subStats.avg}</b> · Highest: <b>{subStats.highest}</b> · Lowest: <b>{subStats.lowest}</b>
          </div>
        </div>

        {/* Below-pass-mark / remedial assignment */}
        {(function(){
          var below = getBelowPassMarkStudents(currentSub);
          if(!below.length) return null;
          return(
            <div style={{...S.card,marginBottom:14,background:"#FEF2F2",border:"1px solid "+C.danger}}>
              <div style={{...S.row,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:C.danger}}>⚠ {below.length} student(s) below pass mark ({rc.passMark}) in {currentSub}</div>
                  <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{below.map(function(s){return s.surname+" "+s.firstname;}).join(", ")}</div>
                </div>
                <button style={S.btn("danger")} onClick={function(){setShowRemedial(true);}}>🎯 Assign Remedial Work</button>
              </div>
            </div>
          );
        })()}

        {/* Score entry grid */}
        {classStudents.length===0 ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No active students in {selClass}{selArm}. Enrol students first.</div>
        ) : (
          <div style={S.card}>
            <div style={{...S.row,justifyContent:"space-between",marginBottom:10}}>
              <div style={S.cardTitle}>{currentSub} — Score Entry</div>
              {saved ? <span style={{color:C.success,fontSize:12,fontWeight:700}}>✅ Saved!</span> : null}
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={{...S.th,textAlign:"left",minWidth:140}}>Student Name</th>
                    <th style={{...S.thC,minWidth:70}}>CA1 ({rc.ca1Max})</th>
                    <th style={{...S.thC,minWidth:70}}>CA2 ({rc.ca2Max})</th>
                    <th style={{...S.thC,minWidth:70}}>Exam ({rc.examMax})</th>
                    <th style={{...S.thC,minWidth:70}}>Total</th>
                    <th style={{...S.thC,minWidth:60}}>Grade</th>
                    <th style={{...S.thC,minWidth:60}}>Position</th>
                  </tr>
                </thead>
                <tbody>
                  {classStudents.map(function(stu){
                    var r = getResult(stu.id, currentSub);
                    var total = r ? (r.total||0) : 0;
                    var grade = getGrade(total, settings);
                    var pos = r ? getSubjectPosition(stu.id, currentSub) : "-";
                    return(
                      <tr key={stu.id}>
                        <td style={{...S.td,fontWeight:600}}>{stu.surname} {stu.firstname}</td>
                        <td style={S.tdC}>
                          <input type="number" min="0" max={rc.ca1Max} style={{...S.input,width:56,textAlign:"center",padding:"3px"}}
                            value={r?r.ca1:""}
                            onChange={function(e){setScore(stu.id,currentSub,"ca1",e.target.value);setSaved(true);setTimeout(function(){setSaved(false);},2000);}}
                            placeholder="0"/>
                        </td>
                        <td style={S.tdC}>
                          <input type="number" min="0" max={rc.ca2Max} style={{...S.input,width:56,textAlign:"center",padding:"3px"}}
                            value={r?r.ca2:""}
                            onChange={function(e){setScore(stu.id,currentSub,"ca2",e.target.value);setSaved(true);setTimeout(function(){setSaved(false);},2000);}}
                            placeholder="0"/>
                        </td>
                        <td style={S.tdC}>
                          <input type="number" min="0" max={rc.examMax} style={{...S.input,width:56,textAlign:"center",padding:"3px"}}
                            value={r?r.exam:""}
                            onChange={function(e){setScore(stu.id,currentSub,"exam",e.target.value);setSaved(true);setTimeout(function(){setSaved(false);},2000);}}
                            placeholder="0"/>
                        </td>
                        <td style={{...S.tdC,fontWeight:700,fontSize:13,color:total>=rc.passMark?C.success:C.danger}}>{total||"-"}</td>
                        <td style={S.tdC}><span style={S.badge(total>=70?"green":total>=50?"yellow":"red")}>{r?grade.grade:"-"}</span></td>
                        <td style={{...S.tdC,fontWeight:600}}>{ordinal(pos)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── BROADSHEET TAB ────────────────────────────────
  function renderBroadsheet(){
    return(
      <div>
        <div style={{...S.card,marginBottom:14}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <select style={S.select} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>
                {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
              </select>
              <select style={S.select} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>
                {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
              </select>
              <select style={S.select} value={selClass} onChange={function(e){setSelClass(e.target.value);}}>
                {CLASSES.map(function(c){return <option key={c}>{c}</option>;})}
              </select>
              <select style={S.select} value={selArm} onChange={function(e){setSelArm(e.target.value);}}>
                {ARMS.map(function(a){return <option key={a}>{a}</option>;})}
              </select>
            </div>
            <button style={S.btn()} onClick={bulkPrint}>🖨 Bulk Print All Cards</button>
          </div>
          <div style={{marginTop:10}}>
            <TableActionBar
              title={"Broadsheet - "+selClass+selArm+" - "+selTerm+" "+selSess}
              columns={["Student"].concat(subjects,["Total","Avg","Position"])}
              rows={classStudents.map(function(stu){
                var stats = getStudentStats(stu.id);
                var subjectCells = subjects.map(function(sub){
                  var r = getResult(stu.id, sub);
                  return r ? (r.total||0) : "—";
                });
                return [stu.surname+" "+stu.firstname].concat(subjectCells,[
                  stats?stats.totalScore:"—", stats?stats.avg:"—", stats?ordinal(stats.position):"—"
                ]);
              })}
            />
          </div>
        </div>

        {/* General class remark — not tied to any one student, printed on every report card for this class/arm/term */}
        {(function(){
          var cr = getClassRemark(selClass, selArm);
          var canTeacher = isClassTeacherOf(selClass);
          return(
            <div style={{...S.card,marginBottom:14}}>
              <div style={S.cardTitle}>General Remark for {selClass}{selArm} — {selTerm} {selSess}</div>
              <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>A class-wide remark (not about any one student) that prints on every report card for this class.</div>
              <div style={S.grid2}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,marginBottom:4}}>Class Teacher's General Remark</div>
                  {canTeacher?(
                    <textarea style={{...S.textarea,minHeight:60}} defaultValue={cr.teacherRemark} key={selClass+selArm+selSess+selTerm+"_t"}
                      onBlur={function(e){ if(e.target.value!==cr.teacherRemark) setClassRemarkField("teacherRemark", e.target.value); }}/>
                  ):(
                    <div style={{...S.textarea,minHeight:60,background:"#F9FAFB",color:cr.teacherRemark?C.text:C.textMuted}}>{cr.teacherRemark||"— no permission to edit —"}</div>
                  )}
                </div>
                <div>
                  <div style={{fontSize:11,fontWeight:700,marginBottom:4}}>Principal's General Remark</div>
                  {isPrincipal?(
                    <textarea style={{...S.textarea,minHeight:60}} defaultValue={cr.principalRemark} key={selClass+selArm+selSess+selTerm+"_p"}
                      onBlur={function(e){ if(e.target.value!==cr.principalRemark) setClassRemarkField("principalRemark", e.target.value); }}/>
                  ):(
                    <div style={{...S.textarea,minHeight:60,background:"#F9FAFB",color:cr.principalRemark?C.text:C.textMuted}}>{cr.principalRemark||"— no permission to edit —"}</div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        <div style={{...S.card,overflowX:"auto"}}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={{...S.th,textAlign:"left",minWidth:140,position:"sticky",left:0,background:"#230E6A"}}>Student</th>
                {subjects.map(function(sub){return <th key={sub} style={{...S.thC,fontSize:9,minWidth:50}}>{sub.slice(0,8)}</th>;})}
                <th style={S.thC}>Total</th>
                <th style={S.thC}>Avg</th>
                <th style={S.thC}>Position</th>
                <th style={S.thC}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {classStudents.map(function(stu){
                var stats = getStudentStats(stu.id);
                return(
                  <tr key={stu.id}>
                    <td style={{...S.td,fontWeight:600,position:"sticky",left:0,background:"#fff"}}>{stu.surname} {stu.firstname}</td>
                    {subjects.map(function(sub){
                      var r = getResult(stu.id, sub);
                      var total = r ? (r.total||0) : null;
                      return(
                        <td key={sub} style={{...S.tdC,color:total===null?C.textMuted:total>=rc.passMark?C.success:C.danger,fontWeight:total!==null?700:400}}>
                          {total===null?"—":total}
                        </td>
                      );
                    })}
                    <td style={{...S.tdC,fontWeight:700}}>{stats?stats.totalScore:"—"}</td>
                    <td style={{...S.tdC,fontWeight:700,color:C.primary}}>{stats?stats.avg:"—"}</td>
                    <td style={{...S.tdC,fontWeight:700,color:"#6B491B"}}>{stats?ordinal(stats.position):"—"}</td>
                    <td style={S.tdC}>
                      <div style={{display:"flex",gap:4,justifyContent:"center"}}>
                        <button onClick={function(){setViewStudent(stu);setTab("card");}} style={{...S.btn("blue"),fontSize:9,padding:"2px 6px"}}>View</button>
                        <button onClick={function(){openPrint(stu);}} style={{...S.btn("secondary"),fontSize:9,padding:"2px 6px"}}>Print</button>
                        <button onClick={function(){shareWhatsApp(stu);}} style={{...S.btn("green"),fontSize:9,padding:"2px 6px"}}>WA</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── REPORT CARD TAB ──────────────────────────────
  function renderCard(){
    var stu = viewStudent;
    if(!stu) return(
      <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
        <div style={{fontSize:32,marginBottom:8}}>📋</div>
        <div>Select a student from the Broadsheet tab to view their report card.</div>
      </div>
    );

    var stats = getStudentStats(stu.id);
    var meta = getStudentMeta(stu.id);
    var classRemark = getClassRemark(stu.class, stu.arm||selArm, selSess, selTerm);
    var stuResults = results.filter(function(r){
      return r.studentId===stu.id && r.session===selSess && r.term===selTerm && r.class===selClass;
    });

    return(
      <div>
        {/* Action bar */}
        <div style={{...S.card,marginBottom:14}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{fontSize:13,fontWeight:700}}>{stu.surname} {stu.firstname} — {selTerm} {selSess}</div>
            <div style={{display:"flex",gap:8}}>
              <div style={S.formGroup}>
                <label style={S.label}>Next Term Begins</label>
                <input style={S.input} type="date" value={nextTerm} onChange={function(e){setNextTerm(e.target.value);}}/>
              </div>
              <div style={S.formGroup}>
                <label style={S.label}>Days School Opened</label>
                <input style={{...S.input,width:80}} type="number" value={daysOpened} onChange={function(e){setDaysOpened(e.target.value);}} placeholder="0"/>
              </div>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button onClick={function(){openPrint(stu);}} style={S.btn()}>🖨 Print</button>
              <button onClick={function(){downloadPDF(stu);}} style={S.btn("blue")}>⬇ Download PDF</button>
              <button onClick={function(){shareReportCard(stu);}} style={S.btn("gold")}>📤 Share</button>
              <button onClick={function(){shareWhatsApp(stu);}} style={S.btn("green")}>📱 WhatsApp</button>
            </div>
          </div>
        </div>

        {/* Report card preview */}
        <div style={{background:"#fff",border:"2px solid #8B0000",borderRadius:8,padding:20,fontFamily:"Arial,sans-serif",fontSize:11}}>
          {/* School header */}
          <div style={{display:"flex",alignItems:"center",gap:10,borderBottom:"3px solid #8B0000",paddingBottom:8,marginBottom:8}}>
            <SchoolLogoImg size={70} bg="#fff"/>
            <div style={{flex:1,textAlign:"center"}}>
              <div style={{fontSize:18,fontWeight:900,color:"#8B0000"}}>ASSANUSIYYAH GROUP OF SCHOOLS</div>
              <div style={{fontSize:11,color:"#444"}}>Learning, Moral And Religion</div>
              <div style={{fontSize:10,color:"#555"}}>P M B 2002, IPETUMODU ROAD, OKE YIDI, ODEOMU, OSUN STATE. | Tel: 08039650771</div>
            </div>
            <SchoolLogoImg size={70} bg="#fff"/>
          </div>

          <div style={{textAlign:"center",fontSize:14,fontWeight:800,color:"#8B0000",textDecoration:"underline",marginBottom:8}}>
            {selTerm.toUpperCase()} EXAMINATION
          </div>

          {/* Student info */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,border:"1px solid #ccc",padding:6,marginBottom:6,fontSize:10}}>
            <div><b>Session:</b> {selSess}/{selTerm.replace(" Term","")}</div>
            <div><b>Term:</b> {selTerm.replace(" Term","")}</div>
            <div><b>Name:</b> <b>{stu.surname} {stu.firstname} {stu.middlename||""}</b></div>
            <div><b>Reg. No:</b> {stu.admissionNo}</div>
            <div><b>Class:</b> {stu.class}{stu.arm||""}</div>
            <div><b>Next term begins:</b> {nextTerm ? formatDate(nextTerm) : "___________"}</div>
          </div>

          {/* Stats */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",border:"1px solid #8B0000",marginBottom:6,fontSize:9.5}}>
            <div style={{padding:"4px 6px",borderRight:"1px solid #8B0000"}}>
              {[
                ...(rc.showPosition?[["Position in class",stats?ordinal(stats.position):"-"]]:[]),
                ["Overall total score",stats?stats.totalScore:"-"],
                ["Student average score",stats?stats.avg:"-"],
                ...(rc.showClassAverage?[["Highest avg in class",stats?stats.classHighest:"-"]]:[]),
              ].map(function(item,i){
                return <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"1px 0",borderBottom:"1px solid #eee"}}><span>{item[0]}</span><b style={{color:"#8B0000"}}>{item[1]}</b></div>;
              })}
            </div>
            <div style={{padding:"4px 6px"}}>
              {[
                ["No. of students in class",classStudents.length],
                ...(rc.showClassAverage?[["Class average score",stats?stats.classAvg:"-"],["Lowest avg in class",stats?stats.classLowest:"-"]]:[]),
                ["Days school opened",daysOpened||"-"],
              ].map(function(item,i){
                return <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"1px 0",borderBottom:"1px solid #eee"}}><span>{item[0]}</span><b style={{color:"#8B0000"}}>{item[1]}</b></div>;
              })}
            </div>
          </div>

          {/* Results table */}
          <table style={{width:"100%",borderCollapse:"collapse",marginBottom:6,fontSize:9}}>
            <thead>
              <tr style={{background:"#8B0000",color:"#fff"}}>
                {[
                  "SUBJECT","TEST 1\n("+rc.ca1Max+")","TEST 2\n("+rc.ca2Max+")","EXAM\n("+rc.examMax+")","TOTAL\n("+(rc.ca1Max+rc.ca2Max+rc.examMax)+")","GRADE",
                  ...(rc.showPosition?["SUBJECT\nPOSITION"]:[]),
                  ...(rc.showClassAverage?["CLASS\nAVERAGE","WEIGHTED\nSCORE","HIGHEST\nIN CLASS","LOWEST\nIN CLASS"]:[]),
                  "REMARK"
                ].map(function(h){
                  return <th key={h} style={{padding:"3px",border:"1px solid #8B0000",textAlign:"center",fontSize:8,whiteSpace:"pre-line"}}>{h}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {subjects.map(function(sub){
                var r = stuResults.find(function(x){return x.subject===sub;});
                if(!r) return null;
                var subStats = getSubjectStats(sub);
                var pos = getSubjectPosition(stu.id, sub);
                var grade = getGrade(r.total||0, settings);
                var weighted = getWeightedScore(r.total||0, subStats.highest);
                return(
                  <tr key={sub} style={{borderBottom:"1px solid #ccc"}}>
                    <td style={{padding:"2px 4px",fontWeight:600,textAlign:"left"}}>{sub}</td>
                    <td style={{padding:"2px",textAlign:"center"}}>{r.ca1||"-"}</td>
                    <td style={{padding:"2px",textAlign:"center"}}>{r.ca2||"-"}</td>
                    <td style={{padding:"2px",textAlign:"center"}}>{r.exam||"-"}</td>
                    <td style={{padding:"2px",textAlign:"center",fontWeight:700}}>{r.total||"-"}</td>
                    <td style={{padding:"2px",textAlign:"center",fontWeight:700,color:r.total>=70?"#006600":r.total>=50?"#806000":"#800000"}}>{grade.grade}</td>
                    {rc.showPosition&&<td style={{padding:"2px",textAlign:"center"}}>{ordinal(pos)}</td>}
                    {rc.showClassAverage&&<>
                      <td style={{padding:"2px",textAlign:"center"}}>{subStats.avg}</td>
                      <td style={{padding:"2px",textAlign:"center"}}>{weighted}</td>
                      <td style={{padding:"2px",textAlign:"center",color:"#006600",fontWeight:700}}>{subStats.highest}</td>
                      <td style={{padding:"2px",textAlign:"center",color:"#800000",fontWeight:700}}>{subStats.lowest}</td>
                    </>}
                    <td style={{padding:"2px",textAlign:"center",fontSize:8,color:r.total>=70?"#006600":r.total>=50?"#806000":"#800000",fontWeight:600}}>{grade.remark}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Bottom section */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:8,fontSize:8.5}}>
            {/* Affective traits */}
            {rc.showAffectiveTraits&&<div>
              <div style={{background:"#8B0000",color:"#fff",padding:"2px 4px",fontWeight:700,fontSize:8}}>AFFECTIVE TRAITS</div>
              {AFFECTIVE_TRAITS.map(function(t){
                var rating = (meta.affectiveTraits||{})[t]||"";
                return(
                  <div key={t} style={{display:"flex",justifyContent:"space-between",padding:"1px 4px",borderBottom:"1px solid #eee"}}>
                    <span>{t}</span>
                    <select value={rating} onChange={function(e){setRating(stu.id,"affective",t,e.target.value);}} style={{fontSize:8,border:"none",background:"transparent",fontWeight:700,color:"#8B0000"}}>
                      <option value="">-</option>
                      {[1,2,3,4,5].map(function(v){return <option key={v} value={v}>{v}</option>;})}
                    </select>
                  </div>
                );
              })}
            </div>}

            {/* Psychomotor + Score Range */}
            <div>
              {rc.showPsychomotorSkills&&<div style={{background:"#8B0000",color:"#fff",padding:"2px 4px",fontWeight:700,fontSize:8}}>PSYCHOMOTOR SKILLS</div>}
              {rc.showPsychomotorSkills&&PSYCHOMOTOR_SKILLS.map(function(t){
                var rating = (meta.psychomotorSkills||{})[t]||"";
                return(
                  <div key={t} style={{display:"flex",justifyContent:"space-between",padding:"1px 4px",borderBottom:"1px solid #eee"}}>
                    <span>{t}</span>
                    <select value={rating} onChange={function(e){setRating(stu.id,"psychomotor",t,e.target.value);}} style={{fontSize:8,border:"none",background:"transparent",fontWeight:700,color:"#8B0000"}}>
                      <option value="">-</option>
                      {[1,2,3,4,5].map(function(v){return <option key={v} value={v}>{v}</option>;})}
                    </select>
                  </div>
                );
              })}
              <div style={{background:"#8B0000",color:"#fff",padding:"2px 4px",fontWeight:700,fontSize:8,marginTop:4}}>SCORE RANGE</div>
              {[["0%-30%","F","Fail"],["30%-40%","E","Poor"],["40%-50%","D","Pass"],["50%-60%","C","Good"],["60%-70%","B","Very good"],["70%-100%","A","Excellent"]].map(function(row,i){
                return <div key={i} style={{display:"flex",gap:4,padding:"1px 4px",borderBottom:"1px solid #eee",fontSize:8}}><span style={{minWidth:50}}>{row[0]}</span><b style={{minWidth:12}}>{row[1]}</b><span>{row[2]}</span></div>;
              })}
            </div>

            {/* Key */}
            <div>
              <div style={{background:"#8B0000",color:"#fff",padding:"2px 4px",fontWeight:700,fontSize:8}}>KEY — MEANING</div>
              {RATING_KEY.map(function(k){
                return <div key={k.v} style={{display:"flex",gap:4,padding:"1px 4px",borderBottom:"1px solid #eee",fontSize:8}}><b style={{minWidth:12}}>{k.v}</b><span>{k.m}</span></div>;
              })}
            </div>
          </div>

          {/* Comments */}
          {rc.showComments&&<div style={{marginBottom:8}}>
            {[["teacherComment","Class Teacher's comment:",isClassTeacherOf(stu.class)],["formMasterComment","Form Master's report:",isClassTeacherOf(stu.class)],["principalComment","Principal's report:",isPrincipal]].map(function(trip){
              var field=trip[0], label=trip[1], canEdit=trip[2];
              return(
                <div key={field} style={{marginBottom:4}}>
                  <div style={{fontSize:9,fontWeight:700}}>{label}</div>
                  {canEdit?(
                    <textarea value={meta[field]||""} onChange={function(e){setComment(stu.id,field,e.target.value);}}
                      style={{width:"100%",border:"1px solid #ccc",borderRadius:3,padding:"3px 5px",fontSize:10,minHeight:28,resize:"vertical",fontFamily:"Arial"}}/>
                  ):(
                    <div style={{width:"100%",border:"1px solid #eee",borderRadius:3,padding:"3px 5px",fontSize:10,minHeight:28,background:"#F9FAFB",color:meta[field]?C.text:C.textMuted}}>{meta[field]||"— no permission to edit this field —"}</div>
                  )}
                </div>
              );
            })}
            {classRemark.teacherRemark&&<div style={{marginBottom:4}}><div style={{fontSize:9,fontWeight:700}}>Class Teacher's General Remark (whole class):</div><div style={{width:"100%",border:"1px solid #eee",borderRadius:3,padding:"3px 5px",fontSize:10,minHeight:28,background:"#F9FAFB"}}>{classRemark.teacherRemark}</div></div>}
            {classRemark.principalRemark&&<div style={{marginBottom:4}}><div style={{fontSize:9,fontWeight:700}}>Principal's General Remark (whole class):</div><div style={{width:"100%",border:"1px solid #eee",borderRadius:3,padding:"3px 5px",fontSize:10,minHeight:28,background:"#F9FAFB"}}>{classRemark.principalRemark}</div></div>}
          </div>}

          {/* Signatures */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginTop:8}}>
            <div style={{textAlign:"center"}}>
              {settings&&settings.schoolStamp ? <img src={settings.schoolStamp} style={{height:60,objectFit:"contain"}}/> : <div style={{height:60,width:80,border:"1px dashed #ccc",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#999"}}>Stamp</div>}
              <div style={{borderTop:"1px solid #000",marginTop:4,paddingTop:2,fontSize:9}}>School Stamp</div>
            </div>
            <div style={{textAlign:"center"}}>
              {settings&&settings.signature ? <img src={settings.signature} style={{height:60,objectFit:"contain"}}/> : <div style={{height:60,width:120,border:"1px dashed #ccc",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#999"}}>Signature</div>}
              <div style={{borderTop:"1px solid #000",marginTop:4,paddingTop:2,fontSize:9}}>Principal's Signature</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return(
    <div>
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border,flexWrap:"wrap"}}>
        {[["entry","✏️ Score Entry"],["broadsheet","📊 Broadsheet"],["card","📋 Report Card"]].map(function(pair){
          return <button key={pair[0]} onClick={function(){setTab(pair[0]);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 14px"}}>{pair[1]}</button>;
        })}
      </div>
      {tab==="entry" ? renderEntry() : null}
      {tab==="broadsheet" ? renderBroadsheet() : null}
      {tab==="card" ? renderCard() : null}

      {/* Assign remedial work to below-pass-mark students */}
      {(function(){
        var currentSub = selSub || subjects[0] || "";
        var below = getBelowPassMarkStudents(currentSub);
        var candidateAssignments = (assignments||[]).filter(function(a){ return a.class===selClass && a.subject===currentSub; });
        return(
          <Modal open={showRemedial} onClose={function(){setShowRemedial(false);setRemedialAsnId("");}} title={"Assign Remedial Work — "+currentSub+" — "+selClass+selArm}>
            <div style={{fontSize:12,color:C.textMuted,marginBottom:10}}>{below.length} student(s) scored below {rc.passMark} in {currentSub}: {below.map(function(s){return s.surname+" "+s.firstname;}).join(", ")}</div>
            {candidateAssignments.length===0?(
              <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:20}}>
                No assignment exists yet for {currentSub} in {selClass}. Create one first from Lesson Notes → publish a lesson with an assignment for this class/subject, then come back here.
              </div>
            ):(
              <div>
                <div style={S.formGroup}>
                  <label style={S.label}>Choose an assignment to target at these students</label>
                  <select style={{...S.select,width:"100%"}} value={remedialAsnId} onChange={function(e){setRemedialAsnId(e.target.value);}}>
                    <option value="">— Select assignment —</option>
                    {candidateAssignments.map(function(a){return <option key={a.id} value={a.id}>{a.title}{a.targetStudentIds&&a.targetStudentIds.length?" (already targeted to "+a.targetStudentIds.length+")":""}</option>;})}
                  </select>
                </div>
                <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}>
                  <button style={S.btn("secondary")} onClick={function(){setShowRemedial(false);setRemedialAsnId("");}}>Cancel</button>
                  <button style={S.btn("danger")} disabled={!remedialAsnId} onClick={function(){assignRemedial(currentSub, remedialAsnId, below.map(function(s){return s.id;}));}}>Assign to {below.length} Student(s)</button>
                </div>
              </div>
            )}
          </Modal>
        );
      })()}
    </div>
  );
}


// Isolated from StaffModule's table so typing in this form never
// re-renders the staff table below it.
function StaffFormModal({open,staffMember,onSave,onClose}){
  const ef={surname:"",firstname:"",middlename:"",dob:"",gender:"Male",phone:"",address:"",qualification:"",nextOfKin:"",nextOfKinPhone:"",subjects:[],classes:[],periodsPerWeek:5,role:"Teacher",active:true,password:""};
  const [form,setForm]=useState(staffMember?{...staffMember}:ef);
  const [selSubs,setSelSubs]=useState(staffMember?(staffMember.subjects||[]):[]);
  const [selCls,setSelCls]=useState(staffMember?(staffMember.classes||[]):[]);

  useEffect(function(){
    if(open){
      setForm(staffMember?{...staffMember}:ef);
      setSelSubs(staffMember?(staffMember.subjects||[]):[]);
      setSelCls(staffMember?(staffMember.classes||[]):[]);
    }
  },[open,staffMember]);

  const allSubs=[...new Set([...SUBJECTS_JNR,...SUBJECTS_SNR])].sort();

  function toggleSub(sub){setSelSubs(p=>p.includes(sub)?p.filter(x=>x!==sub):[...p,sub]);}
  function toggleCls(cls){setSelCls(p=>p.includes(cls)?p.filter(x=>x!==cls):[...p,cls]);}

  function handleSave(){
    if(!form.surname||!form.firstname)return alert("Surname and First Name required.");
    onSave({...form,subjects:selSubs,classes:selCls});
  }

  return(
    <Modal open={open} onClose={onClose} title={staffMember?"Edit Staff Record":"Add Staff Member"} wide>
      <div style={S.grid3}><FormField form={form} setForm={setForm} label="Surname *" field="surname"/><FormField form={form} setForm={setForm} label="First Name *" field="firstname"/><FormField form={form} setForm={setForm} label="Middle Name" field="middlename"/></div>
      <div style={S.grid3}><FormField form={form} setForm={setForm} label="Date of Birth" field="dob" type="date"/><FormField form={form} setForm={setForm} label="Gender" field="gender" opts={["Male","Female"]}/><FormField form={form} setForm={setForm} label="Phone" field="phone"/></div>
      <div style={S.grid2}><FormField form={form} setForm={setForm} label="Highest Qualification" field="qualification"/><FormField form={form} setForm={setForm} label="Role" field="role" opts={["Teacher","Principal","Admin","Bursar","Matron","Hostel Master","Hostel Mistress","Others"]}/></div>
      <div style={S.grid2}><FormField form={form} setForm={setForm} label="Next of Kin" field="nextOfKin"/><FormField form={form} setForm={setForm} label="Next of Kin Phone" field="nextOfKinPhone"/></div>
      <div style={S.formGroup}><FormField form={form} setForm={setForm} label="Periods per Week" field="periodsPerWeek" type="number"/></div>
      <div style={S.formGroup}><label style={S.label}>Address</label><input style={S.input} value={form.address} onChange={e=>setForm(p=>({...p,address:e.target.value}))}/></div>
      <div style={S.formGroup}>
        <label style={S.label}>Subjects Taught</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
          {allSubs.map(sub=><button key={sub} type="button" onClick={()=>toggleSub(sub)} style={{...S.btn(selSubs.includes(sub)?"primary":"secondary"),fontSize:10,padding:"3px 8px"}}>{sub}</button>)}
        </div>
      </div>
      <div style={S.formGroup}>
        <label style={S.label}>Classes</label>
        <div style={{display:"flex",gap:6}}>
          {CLASSES.map(cls=><button key={cls} type="button" onClick={()=>toggleCls(cls)} style={{...S.btn(selCls.includes(cls)?"primary":"secondary"),fontSize:11,padding:"4px 10px"}}>{cls}</button>)}
        </div>
      </div>
      <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={onClose}>Cancel</button><button style={S.btn()} onClick={handleSave}>{staffMember?"Save Changes":"Add Staff"}</button></div>
    </Modal>
  );
}

function StaffModule({staff,setStaff}){
  const [search,setSearch]=useState("");
  const [showForm,setShowForm]=useState(false);
  const [editing,setEditing]=useState(null);
  const [editingStaff,setEditingStaff]=useState(null);
  const [viewStaff,setViewStaff]=useState(null);

  const filtered=staff.filter(s=>!search||`${s.surname} ${s.firstname}`.toLowerCase().includes(search.toLowerCase()));

  function openAdd(){setEditingStaff(null);setEditing(null);setShowForm(true);}
  function openEdit(s){setEditingStaff(s);setEditing(s.id);setShowForm(true);}
  function handleFormSave(rec){
    if(editing){setStaff(p=>p.map(s=>s.id===editing?{...rec,id:editing}:s));}
    else{setStaff(p=>[...p,{...rec,id:genId()}]);}
    setShowForm(false);
  }

  return(<div>
    <div style={{...S.row,marginBottom:12,justifyContent:"space-between"}}>
      <div style={{position:"relative"}}><span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)"}}><Icon name="search" size={13} color={C.textMuted}/></span><input style={{...S.input,paddingLeft:27,width:190}} placeholder="Search staff..." value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <button style={S.btn()} onClick={openAdd}><span style={S.row}><Icon name="plus" size={13}/> Add Staff</span></button>
    </div>
    <div style={{marginBottom:10}}>
      <TableActionBar
        title="Staff List"
        columns={["Full Name","DOB","Phone","Qualification","Subjects","Classes","Periods/Wk","Role"]}
        rows={filtered.map(s=>[`${s.surname} ${s.firstname} ${s.middlename||""}`.trim(),formatDate(s.dob),s.phone,s.qualification,(s.subjects||[]).join(", "),(s.classes||[]).join(", "),s.periodsPerWeek,s.role])}
      />
    </div>
    <div style={S.card}>
      <table style={S.table}><thead><tr>{["Full Name","DOB","Phone","Qualification","Subjects","Classes","Periods/Wk","Role","Actions"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
      <tbody>
        {filtered.length===0&&<tr><td colSpan={9} style={{...S.td,textAlign:"center",color:C.textMuted,padding:28}}>No staff records.</td></tr>}
        {filtered.map(s=>(
          <tr key={s.id}><td style={S.td}><b>{s.surname}</b> {s.firstname} {s.middlename}</td>
          <td style={S.td}>{formatDate(s.dob)}</td><td style={S.td}>{s.phone}</td><td style={S.td}>{s.qualification}</td>
          <td style={S.td}><div style={{display:"flex",flexWrap:"wrap",gap:3}}>{(s.subjects||[]).slice(0,3).map(sub=><span key={sub} style={{...S.badge("blue"),fontSize:9}}>{sub}</span>)}{(s.subjects||[]).length>3&&<span style={{fontSize:9,color:C.textMuted}}>+{s.subjects.length-3}</span>}</div></td>
          <td style={S.td}>{(s.classes||[]).join(", ")}</td>
          <td style={S.tdC}>{s.periodsPerWeek}</td>
          <td style={S.td}><span style={S.badge(s.role==="Teacher"?"blue":s.role==="Admin"?"purple":"green")}>{s.role}</span></td>
          <td style={S.td}><div style={S.row}>
            <button style={{...S.btn("ghost"),padding:3}} onClick={()=>setViewStaff(s)}><Icon name="eye" size={14} color={C.primary}/></button>
            <button style={{...S.btn("ghost"),padding:3}} onClick={()=>openEdit(s)}><Icon name="edit" size={14} color={C.gold}/></button>
          </div></td>
          </tr>
        ))}
      </tbody></table>
    </div>

    <StaffFormModal open={showForm} staffMember={editingStaff} onSave={handleFormSave} onClose={()=>setShowForm(false)}/>

    <Modal open={!!viewStaff} onClose={()=>setViewStaff(null)} title="Staff Profile">
      {viewStaff&&<div>
        <div style={{background:C.primaryDark,borderRadius:8,padding:"13px 16px",marginBottom:14}}>
          <div style={{fontSize:17,fontWeight:800,color:C.goldLight}}>{viewStaff.surname} {viewStaff.firstname} {viewStaff.middlename}</div>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:3}}>{viewStaff.qualification} · {viewStaff.role}</div>
        </div>
        <div style={S.grid2}>{[["DOB",formatDate(viewStaff.dob)],["Phone",viewStaff.phone],["Address",viewStaff.address],["Next of Kin",viewStaff.nextOfKin],["NOK Phone",viewStaff.nextOfKinPhone],["Periods/Wk",viewStaff.periodsPerWeek]].map(([k,v])=>(<div key={k} style={{marginBottom:8}}><div style={{fontSize:10,color:C.textMuted,fontWeight:600}}>{k}</div><div style={{fontSize:12,marginTop:1}}>{v}</div></div>))}</div>
        <div style={{marginTop:10}}><div style={{fontSize:10,color:C.textMuted,fontWeight:600,marginBottom:5}}>SUBJECTS</div><div style={{display:"flex",flexWrap:"wrap",gap:5}}>{(viewStaff.subjects||[]).map(s=><span key={s} style={S.badge("blue")}>{s}</span>)}</div></div>
        <div style={{marginTop:8}}><div style={{fontSize:10,color:C.textMuted,fontWeight:600,marginBottom:5}}>CLASSES</div><div style={{display:"flex",gap:5}}>{(viewStaff.classes||[]).map(c=><span key={c} style={S.badge("green")}>{c}</span>)}</div></div>
      </div>}
    </Modal>
  </div>);
}

// ══════════════════════════════════════════════════════
// TIMETABLE — Auto-generator + Manual editing
// ══════════════════════════════════════════════════════

function generateTimetable(staff, classes, periodsPerDay) {
  var days = ["Monday","Tuesday","Wednesday","Thursday","Friday"];
  var newTT = [];
  var teacherBusy = {};
  var classBusy = {};
  var teacherPeriods = {};

  staff.forEach(function(t) {
    teacherBusy[t.id] = {};
    days.forEach(function(d){ teacherBusy[t.id][d] = {}; });
    teacherPeriods[t.id] = 0;
  });
  classes.forEach(function(cls) {
    classBusy[cls] = {};
    days.forEach(function(d){ classBusy[cls][d] = {}; });
  });

  function eligible(cls, subject) {
    return staff.filter(function(t){
      return t.active &&
        (t.subjects||[]).includes(subject) &&
        (t.classes||[]).includes(cls);
    });
  }

  var warnings = [];

  classes.forEach(function(cls) {
    var subjects = getSubjects(cls);
    if (!subjects || subjects.length === 0) return;
    var totalSlots = days.length * periodsPerDay;
    var target = Math.max(2, Math.min(4, Math.floor(totalSlots / subjects.length)));

    var queue = subjects.map(function(sub){
      return { subject: sub, target: eligible(cls,sub).length>0?target:0, assigned: 0 };
    }).filter(function(q){ return q.target > 0; });

    queue.sort(function(){ return Math.random()-0.5; });

    days.forEach(function(day) {
      for (var period = 1; period <= periodsPerDay; period++) {
        if (classBusy[cls][day][period]) continue;
        var filled = false;
        for (var a = 0; a < queue.length; a++) {
          var item = queue[a];
          if (item.assigned >= item.target) continue;
          var alreadyToday = newTT.filter(function(t){
            return t.class===cls && t.day===day && t.subject===item.subject;
          }).length;
          if (alreadyToday >= 1) continue;
          var elig = eligible(cls, item.subject);
          var avail = null;
          for (var e = 0; e < elig.length; e++) {
            var t = elig[e];
            if (!teacherBusy[t.id][day][period] && teacherPeriods[t.id] < (t.periodsPerWeek||40)) {
              avail = t; break;
            }
          }
          if (avail) {
            newTT.push({ id: genId(), class: cls, day: day, period: period, subject: item.subject, teacherId: avail.id });
            classBusy[cls][day][period] = true;
            teacherBusy[avail.id][day][period] = true;
            teacherPeriods[avail.id]++;
            item.assigned++;
            filled = true;
            break;
          }
        }
        if (!filled) {
          var unmet = queue.filter(function(q){ return q.assigned < q.target; });
          if (unmet.length > 0) warnings.push(cls+" "+day+" P"+period+": no teacher available");
        }
      }
    });

    queue.forEach(function(q) {
      var e = eligible(cls, q.subject);
      if (e.length===0) warnings.push(cls+' "'+q.subject+'": No qualified teacher for this class');
      else if (q.assigned < q.target) warnings.push(cls+' "'+q.subject+'": '+q.assigned+"/"+q.target+" periods filled");
    });
  });

  return { timetable: newTT, warnings: warnings };
}

function TimetableModule({staff, timetable, setTimetable}){
  const [selCls, setSelCls] = useState("JSS1");
  const [showForm, setShowForm] = useState(false);
  const [editSlotData, setEditSlotData] = useState(null);
  const [form, setForm] = useState({class:"JSS1",day:"Monday",period:1,subject:"",teacherId:""});
  const [generating, setGenerating] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [tab, setTab] = useState("view");

  const PPD = 8; // periods per day
  const clsTT = timetable.filter(t=>t.class===selCls);

  function getSlot(day, period){ return clsTT.find(t=>t.day===day&&t.period===period); }

  function getConflicts(){
    const conflicts=[];
    const seen={};
    timetable.forEach(slot=>{
      const key=slot.teacherId+"_"+slot.day+"_"+slot.period;
      if(seen[key]){
        const teacher=staff.find(t=>t.id===slot.teacherId);
        conflicts.push((teacher?teacher.surname+" "+teacher.firstname:"?")+": "+slot.day+" P"+slot.period+" ("+seen[key].class+" & "+slot.class+")");
      } else { seen[key]=slot; }
    });
    return conflicts;
  }

  function getClassStats(cls){
    const slots=timetable.filter(t=>t.class===cls);
    const total=DAYS.length*PPD;
    const subs=[...new Set(slots.map(t=>t.subject))];
    return{filled:slots.length,total:total,pct:Math.round((slots.length/total)*100),subs:subs.length};
  }

  function doGenerate(classesToGen){
    setGenerating(true);
    setTimeout(()=>{
      const kept=timetable.filter(t=>!classesToGen.includes(t.class));
      const result=generateTimetable(staff,classesToGen,PPD);
      setTimetable([...kept,...result.timetable]);
      setWarnings(result.warnings);
      setGenerating(false);
      setTab("view");
    },600);
  }

  function clearClass(cls){
    if(window.confirm("Clear timetable for "+cls+"?"))
      setTimetable(p=>p.filter(t=>t.class!==cls));
  }
  function clearAll(){
    if(window.confirm("Clear ALL timetables?")) setTimetable([]);
  }

  function editSlot(day, period){
    const slot=getSlot(day,period);
    setForm(slot?{...slot}:{class:selCls,day,period,subject:"",teacherId:""});
    setEditSlotData({day,period});
    setShowForm(true);
  }
  function saveSlot(){
    if(!form.subject||!form.teacherId) return alert("Subject and teacher required.");
    const conflict=timetable.find(t=>t.teacherId===form.teacherId&&t.day===form.day&&t.period===form.period&&t.class!==selCls);
    if(conflict) return alert("Teacher already assigned to "+conflict.class+" at this time.");
    const exists=timetable.find(t=>t.class===selCls&&t.day===form.day&&t.period===form.period);
    if(exists){ setTimetable(p=>p.map(t=>(t.class===selCls&&t.day===form.day&&t.period===form.period)?{...t,...form,id:t.id}:t)); }
    else { setTimetable(p=>[...p,{...form,id:genId()}]); }
    setShowForm(false);
  }
  function removeSlot(day,period){
    setTimetable(p=>p.filter(t=>!(t.class===selCls&&t.day===day&&t.period===period)));
  }

  const conflicts=getConflicts();
  const classSubjects=getSubjects(selCls);
  const eligibleTeachers=form.subject
    ?staff.filter(t=>t.active&&(t.subjects||[]).includes(form.subject)&&(t.classes||[]).includes(selCls))
    :staff.filter(t=>t.active&&(t.classes||[]).includes(selCls));

  const teacherSummary=staff.filter(s=>s.active).map(t=>{
    const assigned=timetable.filter(s=>s.teacherId===t.id).length;
    return{...t,assigned,target:t.periodsPerWeek||0};
  });

  return(
    <div>
      {/* Controls */}
      <div style={{...S.card,marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:10,alignItems:"center"}}>
          <div style={S.row}>
            <label style={{...S.label,marginBottom:0,marginRight:4}}>Class:</label>
            <select style={{...S.select,width:100}} value={selCls} onChange={e=>setSelCls(e.target.value)}>
              {CLASSES.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
          <div style={S.row}>
            <button style={{...S.btn(tab==="view"?"primary":"secondary"),fontSize:11}} onClick={()=>setTab("view")}>📅 View</button>
            <button style={{...S.btn(tab==="generate"?"primary":"secondary"),fontSize:11}} onClick={()=>setTab("generate")}>⚡ Auto-Generate</button>
            <button style={{...S.btn(tab==="check"?"primary":"secondary"),fontSize:11}} onClick={()=>setTab("check")}>🔍 Check</button>
            <button style={{...S.btn("secondary"),fontSize:11}} onClick={()=>window.print()}>🖨 Print</button>
          </div>
        </div>
        {conflicts.length>0&&(
          <div style={{marginTop:10,background:C.dangerLight,border:"1px solid "+C.danger,borderRadius:6,padding:"7px 12px"}}>
            <span style={{color:C.danger,fontSize:11,fontWeight:700}}>⚠ {conflicts.length} teacher conflict(s) — see Check tab</span>
          </div>
        )}
      </div>

      {/* ── GENERATE TAB ── */}
      {tab==="generate"&&(
        <div>
          <div style={S.card}>
            <div style={S.cardTitle}>⚡ Auto-Generate Timetable</div>
            <div style={{fontSize:12,color:C.textMuted,marginBottom:14,lineHeight:1.7}}>
              The generator reads each teacher's <b>subjects</b>, <b>classes</b>, and <b>periods/week</b> from the Staff module.
              It ensures: no teacher is double-booked, each subject gets 2–4 periods/week spread across different days, and teacher period limits are respected.
            </div>

            <div style={S.cardTitle}>Staff Readiness</div>
            <div style={{overflowX:"auto",marginBottom:16}}>
              <table style={S.table}>
                <thead><tr>{["Teacher","Subjects","Classes","Periods/Wk","Ready?"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {staff.filter(s=>s.active).length===0&&(
                    <tr><td colSpan={5} style={{...S.td,textAlign:"center",color:C.danger,padding:20}}>No staff added yet. Go to Staff module first.</td></tr>
                  )}
                  {staff.filter(s=>s.active).map(t=>{
                    const hasSubs=(t.subjects||[]).length>0;
                    const hasCls=(t.classes||[]).length>0;
                    const hasPeriods=(t.periodsPerWeek||0)>0;
                    const ready=hasSubs&&hasCls&&hasPeriods;
                    return(
                      <tr key={t.id} style={{background:ready?"#F0FDF4":C.warningLight}}>
                        <td style={{...S.td,fontWeight:600}}>{t.surname} {t.firstname}</td>
                        <td style={S.td}>
                          {!hasSubs?<span style={{color:C.danger,fontSize:11}}>None assigned</span>
                          :<div style={{display:"flex",flexWrap:"wrap",gap:3}}>{(t.subjects||[]).map(s=><span key={s} style={{...S.badge("blue"),fontSize:9}}>{s}</span>)}</div>}
                        </td>
                        <td style={S.td}>
                          {!hasCls?<span style={{color:C.danger,fontSize:11}}>None assigned</span>
                          :<div style={{display:"flex",gap:3}}>{(t.classes||[]).map(c=><span key={c} style={S.badge("green")}>{c}</span>)}</div>}
                        </td>
                        <td style={S.tdC}>{hasPeriods?t.periodsPerWeek:<span style={{color:C.danger}}>0 !</span>}</td>
                        <td style={S.tdC}><span style={S.badge(ready?"green":"yellow")}>{ready?"✓ Ready":"⚠ Fix"}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={S.cardTitle}>Generate</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
              <div style={{background:"#EFF6FF",border:"2px solid "+C.blue,borderRadius:10,padding:20,cursor:"pointer",textAlign:"center"}}
                onClick={()=>!generating&&doGenerate(CLASSES)}>
                <div style={{fontSize:28,marginBottom:6}}>🏫</div>
                <div style={{fontWeight:700,fontSize:13,color:C.primaryDark}}>Generate ALL Classes</div>
                <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>Clears and fills all {CLASSES.length} classes</div>
                {generating&&<div style={{color:C.blue,fontSize:11,marginTop:6,fontWeight:600}}>⏳ Generating...</div>}
              </div>
              <div style={{background:"#FFFBEB",border:"2px solid "+C.gold,borderRadius:10,padding:20,cursor:"pointer",textAlign:"center"}}
                onClick={()=>!generating&&doGenerate([selCls])}>
                <div style={{fontSize:28,marginBottom:6}}>📋</div>
                <div style={{fontWeight:700,fontSize:13,color:C.primaryDark}}>Generate {selCls} Only</div>
                <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>Keeps other classes intact</div>
                {generating&&<div style={{color:C.gold,fontSize:11,marginTop:6,fontWeight:600}}>⏳ Generating...</div>}
              </div>
            </div>

            <div style={S.row}>
              <button style={{...S.btn("danger"),fontSize:11}} onClick={()=>clearClass(selCls)}>Clear {selCls}</button>
              <button style={{...S.btn("danger"),fontSize:11}} onClick={clearAll}>Clear ALL</button>
            </div>

            {warnings.length>0&&(
              <div style={{marginTop:14,background:C.warningLight,border:"1px solid "+C.warning,borderRadius:8,padding:12}}>
                <div style={{fontWeight:700,fontSize:12,color:C.warning,marginBottom:8}}>⚠ Warnings ({warnings.length})</div>
                {warnings.slice(0,8).map((w,i)=><div key={i} style={{fontSize:11,color:C.warning,marginBottom:2}}>• {w}</div>)}
                {warnings.length>8&&<div style={{fontSize:11,color:C.textMuted}}>+{warnings.length-8} more. Fix staff assignments to resolve.</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── VIEW TAB ── */}
      {tab==="view"&&(
        <div style={S.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:C.primaryDark}}>{selCls} Weekly Timetable</div>
            <div style={S.row}>
              <span style={{fontSize:11,color:C.textMuted}}>{getClassStats(selCls).filled}/{getClassStats(selCls).total} slots · {getClassStats(selCls).subs} subjects</span>
              <button style={{...S.btn("gold"),fontSize:10,padding:"4px 10px"}} onClick={()=>setTab("generate")}>⚡ Re-generate</button>
            </div>
          </div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,tableLayout:"fixed",minWidth:650}}>
              <thead>
                <tr>
                  <th style={{...S.th,width:55,textAlign:"center"}}>Period</th>
                  {DAYS.map(d=><th key={d} style={S.thC}>{d}</th>)}
                </tr>
              </thead>
              <tbody>
                {Array.from({length:PPD},(_,idx)=>idx+1).map(period=>(
                  <tr key={period}>
                    <td style={{padding:"6px",borderBottom:"1px solid "+C.border,textAlign:"center",fontWeight:700,color:period===4?C.gold:C.primaryDark,background:period===4?"#FFFBEB":C.ivory,fontSize:11}}>
                      {period===4?"BREAK":"P"+period}
                    </td>
                    {DAYS.map(day=>{
                      if(period===4) return(
                        <td key={day} style={{padding:"6px",borderBottom:"1px solid "+C.border,background:"#FFFBEB",textAlign:"center",color:C.gold,fontSize:10,fontWeight:700}}>— BREAK —</td>
                      );
                      const slot=getSlot(day,period);
                      const teacher=slot?staff.find(t=>t.id===slot.teacherId):null;
                      return(
                        <td key={day} onClick={()=>editSlot(day,period)}
                          style={{padding:"6px",borderBottom:"1px solid "+C.border,cursor:"pointer",background:slot?"#EFF6FF":"transparent",verticalAlign:"middle",minWidth:110}}>
                          {slot?(
                            <div>
                              <div style={{fontSize:11,fontWeight:700,color:C.blue}}>{slot.subject}</div>
                              <div style={{fontSize:9,color:C.textMuted,marginTop:1}}>{teacher?teacher.surname+" "+teacher.firstname:"—"}</div>
                              <button style={{...S.btn("danger"),fontSize:9,padding:"1px 5px",marginTop:3}}
                                onClick={e=>{e.stopPropagation();removeSlot(day,period);}}>✕ Remove</button>
                            </div>
                          ):(
                            <div style={{color:C.border,fontSize:10,textAlign:"center"}}>+ Add</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{marginTop:8,fontSize:10,color:C.textMuted}}>Click any slot to assign/edit · Period 4 = Break</div>
        </div>
      )}

      {/* ── CHECK TAB ── */}
      {tab==="check"&&(
        <div>
          <div style={{...S.card,border:"2px solid "+(conflicts.length>0?C.danger:C.success)}}>
            <div style={{...S.cardTitle,color:conflicts.length>0?C.danger:C.success}}>
              {conflicts.length>0?"⚠ "+conflicts.length+" Conflict(s) Found":"✓ No Conflicts — Timetable Valid"}
            </div>
            {conflicts.map((c,i)=><div key={i} style={{fontSize:12,color:C.danger,padding:"4px 0",borderBottom:"1px solid "+C.border}}>• {c}</div>)}
            {conflicts.length===0&&<div style={{fontSize:12,color:C.success}}>All teacher slots are conflict-free.</div>}
          </div>

          <div style={S.card}>
            <div style={S.cardTitle}>Class Coverage</div>
            <table style={S.table}>
              <thead><tr>{["Class","Filled","Total","Rate","Subjects","View"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {CLASSES.map(cls=>{
                  const st=getClassStats(cls);
                  return(
                    <tr key={cls}>
                      <td style={{...S.td,fontWeight:700}}>{cls}</td>
                      <td style={S.tdC}>{st.filled}</td>
                      <td style={S.tdC}>{st.total}</td>
                      <td style={S.td}>
                        <div style={S.row}>
                          <MiniBar value={st.filled} max={st.total} color={st.pct>=80?C.success:st.pct>=50?C.gold:C.danger}/>
                          <span style={{fontSize:10,fontWeight:700,minWidth:34}}>{st.pct}%</span>
                        </div>
                      </td>
                      <td style={S.tdC}>{st.subs}</td>
                      <td style={S.td}>
                        <button style={{...S.btn("primary"),fontSize:10,padding:"3px 8px"}} onClick={()=>{setSelCls(cls);setTab("view");}}>View</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={S.card}>
            <div style={S.cardTitle}>Teacher Workload</div>
            <table style={S.table}>
              <thead><tr>{["Teacher","Subjects","Classes","Target","Assigned","Status"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {teacherSummary.map(t=>{
                  const over=t.assigned>t.target;
                  const under=t.target>0&&t.assigned<Math.floor(t.target*0.5);
                  return(
                    <tr key={t.id} style={{background:over?C.dangerLight:under?C.warningLight:C.white}}>
                      <td style={{...S.td,fontWeight:600}}>{t.surname} {t.firstname}</td>
                      <td style={S.td}>
                        <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                          {(t.subjects||[]).slice(0,3).map(s=><span key={s} style={{...S.badge("blue"),fontSize:9}}>{s}</span>)}
                          {(t.subjects||[]).length>3&&<span style={{fontSize:9,color:C.textMuted}}>+{t.subjects.length-3}</span>}
                        </div>
                      </td>
                      <td style={S.td}>{(t.classes||[]).join(", ")||"—"}</td>
                      <td style={S.tdC}>{t.target}</td>
                      <td style={{...S.tdC,fontWeight:700,color:over?C.danger:C.text}}>{t.assigned}</td>
                      <td style={S.tdC}><span style={S.badge(over?"red":under?"yellow":"green")}>{over?"Overloaded":under?"Under-used":"✓ OK"}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit slot modal */}
      <Modal open={showForm} onClose={()=>setShowForm(false)}
        title={(editSlotData?editSlotData.day+" — Period "+editSlotData.period:"")+' — '+selCls}>
        <div style={S.formGroup}>
          <label style={S.label}>Subject</label>
          <select style={{...S.select,width:"100%"}} value={form.subject}
            onChange={e=>setForm(p=>({...p,subject:e.target.value,teacherId:""}))}>
            <option value="">-- Select Subject --</option>
            {classSubjects.map(s=><option key={s}>{s}</option>)}
          </select>
        </div>
        <div style={S.formGroup}>
          <label style={S.label}>Teacher {form.subject?"(qualified for "+form.subject+" in "+selCls+")":""}</label>
          <select style={{...S.select,width:"100%"}} value={form.teacherId}
            onChange={e=>setForm(p=>({...p,teacherId:e.target.value}))}>
            <option value="">-- Select Teacher --</option>
            {eligibleTeachers.length===0&&<option disabled>No qualified teacher found for this subject+class</option>}
            {eligibleTeachers.map(t=>{
              const busy=timetable.find(s=>s.teacherId===t.id&&s.day===form.day&&s.period===form.period&&s.class!==selCls);
              return <option key={t.id} value={t.id} disabled={!!busy}>{t.surname} {t.firstname}{busy?" (BUSY — "+busy.class+")":""}</option>;
            })}
          </select>
          {form.subject&&eligibleTeachers.length===0&&(
            <div style={{fontSize:10,color:C.danger,marginTop:4}}>Go to Staff → assign "{form.subject}" to a teacher for {selCls}</div>
          )}
        </div>
        <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}>
          <button style={S.btn("secondary")} onClick={()=>setShowForm(false)}>Cancel</button>
          <button style={S.btn()} onClick={saveSlot}>Save Slot</button>
        </div>
      </Modal>
    </div>
  );
}


function MessagesModule({students,staff,messages,setMessages}){
  const [tab,setTab]=useState("box");
  const [showNew,setShowNew]=useState(false);
  const [compose,setCompose]=useState({title:"",body:"",type:"General"});
  const [sendMode,setSendMode]=useState("bulk");
  const [selMsg,setSelMsg]=useState(null);
  const [targetType,setTargetType]=useState("students");
  const [targetClass,setTargetClass]=useState("");
  const [selStu,setSelStu]=useState("");
  const [selStaff,setSelStaff]=useState("");

  function saveMessage(){if(!compose.title||!compose.body)return alert("Title and body required.");setMessages(p=>[...p,{...compose,id:genId(),createdAt:today()}]);setShowNew(false);setCompose({title:"",body:"",type:"General"});}

  function doSend(msg){
    let targets=[];
    if(sendMode==="bulk"){
      if(targetType==="students"){const sGroup=targetClass?students.filter(s=>s.active&&s.class===targetClass):students.filter(s=>s.active);targets=sGroup.map(s=>({phone:s.parentPhone,name:`${s.firstname} ${s.surname}`}));}
      else{targets=staff.filter(s=>s.active).map(s=>({phone:s.phone,name:`${s.firstname} ${s.surname}`}));}
      sendBulkSMS(targets,msg.body,"Bulk Message");
      alert(`Bulk SMS sent to ${targets.length} recipients.\n[SMS stub — connect API to go live]`);
    } else {
      const stu=selStu?students.find(s=>s.id===selStu):null;
      const stf=selStaff?staff.find(s=>s.id===selStaff):null;
      const target=stu||stf;
      if(!target)return alert("Select a recipient.");
      const phone=stu?stu.parentPhone:stf.phone;
      const name=stu?`${stu.firstname} ${stu.surname}`:`${stf.firstname} ${stf.surname}`;
      sendSMS(phone,msg.body.replace("{{name}}",name),"Individual Message");
      alert(`SMS sent to ${name} (${phone}).\n[SMS stub — connect API to go live]`);
    }
    setSelMsg(null);
  }

  return(<div>
    <Tabs tabs={[["box","Message Box"],["send","Send Message"]]} active={tab} onChange={setTab}/>
    {tab==="box"&&<div>
      <div style={{...S.row,marginBottom:12,justifyContent:"flex-end"}}><button style={S.btn()} onClick={()=>setShowNew(true)}><span style={S.row}><Icon name="plus" size={13}/> New Message Template</span></button></div>
      <div style={S.card}>
        <table style={S.table}><thead><tr>{["Title","Type","Preview","Created","Actions"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
        <tbody>
          {messages.map(m=>(
            <tr key={m.id}>
              <td style={{...S.td,fontWeight:600}}>{m.title}</td>
              <td style={S.td}><span style={S.badge(m.type==="Receipt"?"green":m.type==="Fee Reminder"||m.type==="Absence"?"red":m.type==="Birthday"?"gold":"blue")}>{m.type}</span></td>
              <td style={{...S.td,color:C.textMuted,fontSize:11,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.body.slice(0,60)}…</td>
              <td style={S.td}>{formatDate(m.createdAt)}</td>
              <td style={S.td}><div style={S.row}>
                <button style={{...S.btn("primary"),fontSize:10,padding:"4px 8px"}} onClick={()=>{setSelMsg(m);setTab("send");}}>Use</button>
                <button style={{...S.btn("danger"),fontSize:10,padding:"4px 8px"}} onClick={()=>setMessages(p=>p.filter(x=>x.id!==m.id))}>Delete</button>
              </div></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <Modal open={showNew} onClose={()=>setShowNew(false)} title="New Message Template">
        <div style={S.formGroup}><label style={S.label}>Title</label><input style={S.input} value={compose.title} onChange={e=>setCompose(p=>({...p,title:e.target.value}))}/></div>
        <div style={S.formGroup}><label style={S.label}>Type</label><select style={{...S.select,width:"100%"}} value={compose.type} onChange={e=>setCompose(p=>({...p,type:e.target.value}))}>{["General","Fee Reminder","Receipt","Clearance","Absence","Birthday","Academic","Others"].map(o=><option key={o}>{o}</option>)}</select></div>
        <div style={S.formGroup}><label style={S.label}>Message Body <span style={{fontSize:10,color:C.textMuted}}>(use {"{{name}}"}, {"{{amount}}"}, {"{{term}}"} as placeholders)</span></label><textarea style={S.textarea} rows={5} value={compose.body} onChange={e=>setCompose(p=>({...p,body:e.target.value}))}/></div>
        <div style={{...S.row,justifyContent:"flex-end",marginTop:12,gap:8}}><button style={S.btn("secondary")} onClick={()=>setShowNew(false)}>Cancel</button><button style={S.btn()} onClick={saveMessage}>Save Template</button></div>
      </Modal>
    </div>}

    {tab==="send"&&<div>
      {selMsg&&<div style={{...S.card,border:`2px solid ${C.gold}`,marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:C.primaryDark,marginBottom:4}}>Selected: {selMsg.title}</div>
        <div style={{fontSize:11,color:C.textMuted,background:C.ivory,padding:"8px 10px",borderRadius:6,whiteSpace:"pre-line"}}>{selMsg.body}</div>
      </div>}
      {!selMsg&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:20,marginBottom:14}}>Select a message template from the Message Box, or choose one below.</div>}
      <div style={S.card}>
        <div style={S.cardTitle}>Send Configuration</div>
        <div style={S.grid2}>
          <div style={S.formGroup}><label style={S.label}>Send Mode</label><select style={{...S.select,width:"100%"}} value={sendMode} onChange={e=>setSendMode(e.target.value)}><option value="bulk">Bulk SMS</option><option value="individual">Individual SMS</option></select></div>
          {sendMode==="bulk"&&<><div style={S.formGroup}><label style={S.label}>Target</label><select style={{...S.select,width:"100%"}} value={targetType} onChange={e=>setTargetType(e.target.value)}><option value="students">Students' Parents</option><option value="staff">Staff</option></select></div><div style={S.formGroup}><label style={S.label}>Filter by Class (optional)</label><select style={{...S.select,width:"100%"}} value={targetClass} onChange={e=>setTargetClass(e.target.value)}><option value="">All Classes</option>{CLASSES.map(c=><option key={c}>{c}</option>)}</select></div></>}
          {sendMode==="individual"&&<><div style={S.formGroup}><label style={S.label}>Student (optional)</label><select style={{...S.select,width:"100%"}} value={selStu} onChange={e=>{setSelStu(e.target.value);setSelStaff("");}}><option value="">-- Select Student --</option>{students.filter(s=>s.active).map(s=><option key={s.id} value={s.id}>{s.surname} {s.firstname}</option>)}</select></div><div style={S.formGroup}><label style={S.label}>Staff (optional)</label><select style={{...S.select,width:"100%"}} value={selStaff} onChange={e=>{setSelStaff(e.target.value);setSelStu("");}}><option value="">-- Select Staff --</option>{staff.map(s=><option key={s.id} value={s.id}>{s.surname} {s.firstname}</option>)}</select></div></>}
        </div>
        <div style={{marginTop:12}}>
          <div style={{fontSize:11,color:C.textMuted,marginBottom:8}}>Or use template:</div>
          <select style={{...S.select,width:"100%",marginBottom:12}} value={selMsg?.id||""} onChange={e=>setSelMsg(messages.find(m=>m.id===e.target.value)||null)}>
            <option value="">-- Select template --</option>{messages.map(m=><option key={m.id} value={m.id}>{m.title} ({m.type})</option>)}
          </select>
          <button style={{...S.btn(),width:"100%"}} onClick={()=>selMsg?doSend(selMsg):alert("Select a message template first.")}><span style={S.row}><Icon name="sms" size={14}/>{sendMode==="bulk"?`Send Bulk SMS to ${targetType==="students"?(targetClass?students.filter(s=>s.active&&s.class===targetClass).length:students.filter(s=>s.active).length)+" parents":staff.filter(s=>s.active).length+" staff members"}` : "Send Individual SMS"}</span></button>
          <div style={{fontSize:10,color:C.textMuted,marginTop:6,textAlign:"center"}}>[SMS stub — connect Termii or Twilio to activate real sending]</div>
        </div>
      </div>
    </div>}
  </div>);
}

// ══════════════════════════════════════════════════════
// WELFARE — Birthday auto-messages + Conduct
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// ITEM 13: WELFARE & DISCIPLINARY RECORDS — Expanded
// Incident logging, resolutions, parent notifications
// ══════════════════════════════════════════════════════
function WelfareModule({students, staff, conduct, setConduct, messages, settings, currentUser}){
  var _tab = useState("incidents"); var tab = _tab[0]; var setTab = _tab[1];
  var _search = useState(""); var search = _search[0]; var setSearch = _search[1];
  var _showForm = useState(false); var showForm = _showForm[0]; var setShowForm = _showForm[1];
  var _viewing = useState(null); var viewing = _viewing[0]; var setViewing = _viewing[1];
  var _filterType = useState(""); var filterType = _filterType[0]; var setFilterType = _filterType[1];
  var _filterStatus = useState(""); var filterStatus = _filterStatus[0]; var setFilterStatus = _filterStatus[1];

  var INCIDENT_TYPES = ["Lateness","Truancy / Absenteeism","Bullying","Fighting","Theft","Vandalism","Insubordination","Exam Malpractice","Drug / Substance","Indecent Dressing","Pornographic Material","Verbal Abuse","Sexual Misconduct","Destruction of Property","Leaving School Without Permission","Mobile Phone Violation","Others"];
  var SEVERITIES = ["Minor","Moderate","Serious","Very Serious","Expellable"];
  var STATUSES = ["Open","Under Review","Resolved","Escalated","Parent Notified","Suspended","Expelled"];
  var ACTIONS = ["Verbal Warning","Written Warning","Detention","Community Service","Suspension (1-3 days)","Suspension (1 week)","Parent Invited","Referred to Counsellor","Referred to Principal","Police Notified","Expelled"];

  var emptyForm = {
    studentId:"", date:today(), time:new Date().toLocaleTimeString("en-NG",{hour:"2-digit",minute:"2-digit"}),
    incidentType:"Lateness", severity:"Minor", description:"",
    witnesses:"", location:"", reportedBy:currentUser.name||"",
    actionTaken:"Verbal Warning", status:"Open",
    parentNotified:false, followUpDate:"", resolution:"", notes:""
  };
  var _form = useState(emptyForm); var form = _form[0]; var setForm = _form[1];

  function save(){
    if(!form.studentId) return alert("Please select a student.");
    if(!form.description.trim()) return alert("Please describe the incident.");
    var stu = students.find(function(s){return s.id===form.studentId;});
    var rec = {...form, id:genId(), studentName:stu?(stu.surname+" "+stu.firstname):"", class:stu?(stu.class+(stu.arm||"")):"", session:CURRENT_SESSION, term:CURRENT_TERM};
    setConduct(function(p){return[rec,...p];});
    // SMS parent if selected
    if(form.parentNotified && stu && stu.parentPhone){
      sendSMS(stu.parentPhone,
        "Dear Parent of "+stu.firstname+" "+stu.surname+", this is to inform you of an incident involving your ward on "+formatDate(form.date)+". Incident: "+form.incidentType+". Action taken: "+form.actionTaken+". Please contact the school for more details. — "+SCHOOL_NAME,
        "Disciplinary Notice"
      );
    }
    setShowForm(false);
    setForm(emptyForm);
  }

  function printReport(rec){
    var hdr = buildDocHeader(settings, "DISCIPLINARY INCIDENT REPORT");
    var stu = students.find(function(s){return s.id===rec.studentId;});
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Incident Report</title><style>'+hdr.printStyles+'</style></head><body>'+hdr.headerHtml+
      '<table style="margin-bottom:12px;"><tr><td style="width:50%;"><b>Student:</b> '+rec.studentName+'</td><td><b>Class:</b> '+rec.class+'</td></tr>'+
      '<tr><td><b>Admission No.:</b> '+(stu?stu.admissionNo:"—")+'</td><td><b>Date:</b> '+formatDate(rec.date)+' '+rec.time+'</td></tr>'+
      '<tr><td><b>Incident Type:</b> '+rec.incidentType+'</td><td><b>Severity:</b> '+rec.severity+'</td></tr>'+
      '<tr><td><b>Location:</b> '+(rec.location||"—")+'</td><td><b>Reported By:</b> '+rec.reportedBy+'</td></tr></table>'+
      '<div style="margin-bottom:10px;"><b>Description:</b><div style="border:1px solid #ddd;padding:8px;margin-top:4px;min-height:40px;">'+rec.description+'</div></div>'+
      (rec.witnesses?'<div style="margin-bottom:10px;"><b>Witnesses:</b> '+rec.witnesses+'</div>':"")+
      '<div style="margin-bottom:10px;"><b>Action Taken:</b> '+rec.actionTaken+'</div>'+
      '<div style="margin-bottom:10px;"><b>Status:</b> '+rec.status+'</div>'+
      (rec.resolution?'<div style="margin-bottom:10px;"><b>Resolution:</b> '+rec.resolution+'</div>':"")+
      (rec.notes?'<div style="margin-bottom:10px;"><b>Notes:</b> '+rec.notes+'</div>':"")+
      '<div style="margin-top:20px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;">'+
      '<div><div style="border-top:1px solid #000;margin-top:30px;font-size:9px;text-align:center;">Class Teacher</div></div>'+
      '<div><div style="border-top:1px solid #000;margin-top:30px;font-size:9px;text-align:center;">Form Master</div></div>'+
      '<div><div style="border-top:1px solid #000;margin-top:30px;font-size:9px;text-align:center;">Principal</div></div>'+
      '</div>'+hdr.footerHtml+'</body></html>';
    var w = window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.print();}
  }

  var records = conduct.filter(function(r){
    var matchSearch = !search||(r.studentName+r.incidentType+r.description).toLowerCase().includes(search.toLowerCase());
    var matchType = !filterType||r.incidentType===filterType;
    var matchStatus = !filterStatus||r.status===filterStatus;
    return matchSearch && matchType && matchStatus;
  }).sort(function(a,b){return b.date.localeCompare(a.date);});

  // Stats
  var thisTermCases = conduct.filter(function(r){return r.session===CURRENT_SESSION&&r.term===CURRENT_TERM;});
  var openCases = conduct.filter(function(r){return r.status==="Open"||r.status==="Under Review";});
  var severeCases = conduct.filter(function(r){return r.severity==="Serious"||r.severity==="Very Serious"||r.severity==="Expellable";});
  var typeMap = {};
  thisTermCases.forEach(function(r){typeMap[r.incidentType]=(typeMap[r.incidentType]||0)+1;});
  var topTypes = Object.entries(typeMap).sort(function(a,b){return b[1]-a[1];}).slice(0,6);

  return(
    <div>
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border}}>
        {[["incidents","📋 All Incidents"],["open","🔴 Open Cases"],["stats","📊 Statistics"]].map(function(pair){
          return <button key={pair[0]} onClick={function(){setTab(pair[0]);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 14px"}}>{pair[1]}{pair[0]==="open"?<span style={{background:"#DC2626",color:"#fff",borderRadius:"50%",fontSize:9,padding:"0 4px",marginLeft:4}}>{openCases.length}</span>:null}</button>;
        })}
      </div>

      {tab==="incidents"||tab==="open" ? (
        <div>
          <div style={{...S.card,marginBottom:14}}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <input style={{...S.input,minWidth:180}} placeholder="Search student, incident..." value={search} onChange={function(e){setSearch(e.target.value);}}/>
                <select style={S.select} value={filterType} onChange={function(e){setFilterType(e.target.value);}}>
                  <option value="">All Types</option>
                  {INCIDENT_TYPES.map(function(t){return <option key={t}>{t}</option>;})}
                </select>
                <select style={S.select} value={filterStatus} onChange={function(e){setFilterStatus(e.target.value);}}>
                  <option value="">All Statuses</option>
                  {STATUSES.map(function(s){return <option key={s}>{s}</option>;})}
                </select>
              </div>
              <button onClick={function(){setForm(emptyForm);setShowForm(true);}} style={S.btn()}>+ Log Incident</button>
            </div>
            <div style={{fontSize:11,color:C.textMuted,marginTop:6}}>{records.length} incident{records.length!==1?"s":""} · {openCases.length} open</div>
          </div>

          {viewing ? (
            <div style={S.card}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}>
                <div style={{fontSize:14,fontWeight:700,color:C.danger}}>Incident Record — {viewing.studentName}</div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={function(){printReport(viewing);}} style={{...S.btn("blue"),fontSize:11}}>🖨 Print Report</button>
                  <button onClick={function(){setViewing(null);}} style={{...S.btn("secondary"),fontSize:11}}>← Back</button>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                {[["Student",viewing.studentName],["Class",viewing.class],["Date",formatDate(viewing.date)+" · "+viewing.time],["Incident Type",viewing.incidentType],["Severity",viewing.severity],["Location",viewing.location||"—"],["Reported By",viewing.reportedBy],["Status",viewing.status]].map(function(pair,i){
                  return <div key={i} style={S.card}><div style={{fontSize:10,color:C.textMuted,fontWeight:700,marginBottom:3}}>{pair[0]}</div><div style={{fontSize:12,fontWeight:600}}>{pair[1]}</div></div>;
                })}
              </div>
              <div style={{...S.card,marginBottom:10}}><div style={{fontSize:10,fontWeight:700,color:C.textMuted,marginBottom:6}}>DESCRIPTION</div><div style={{fontSize:13,lineHeight:1.6}}>{viewing.description}</div></div>
              {viewing.witnesses?<div style={{...S.card,marginBottom:10}}><div style={{fontSize:10,fontWeight:700,color:C.textMuted,marginBottom:4}}>WITNESSES</div><div style={{fontSize:12}}>{viewing.witnesses}</div></div>:null}
              <div style={{...S.card,marginBottom:10}}><div style={{fontSize:10,fontWeight:700,color:C.textMuted,marginBottom:4}}>ACTION TAKEN</div><div style={{fontSize:12,fontWeight:600}}>{viewing.actionTaken}</div></div>
              {viewing.resolution?<div style={{...S.card,marginBottom:10}}><div style={{fontSize:10,fontWeight:700,color:C.success,marginBottom:4}}>RESOLUTION</div><div style={{fontSize:12}}>{viewing.resolution}</div></div>:null}
              {viewing.notes?<div style={S.card}><div style={{fontSize:10,fontWeight:700,color:C.textMuted,marginBottom:4}}>NOTES</div><div style={{fontSize:12}}>{viewing.notes}</div></div>:null}
            </div>
          ) : (
            records.length===0 ? (
              <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
                <div style={{fontSize:36,marginBottom:8}}>📋</div>
                <div style={{fontSize:13,fontWeight:600}}>{tab==="open"?"No open cases":"No incidents recorded"}</div>
              </div>
            ) : (
              records.filter(function(r){return tab==="open"?(r.status==="Open"||r.status==="Under Review"):true;}).map(function(r){
                return(
                  <div key={r.id} style={{...S.card,marginBottom:10,cursor:"pointer",borderLeft:"3px solid "+(r.severity==="Minor"?"#D97706":r.severity==="Moderate"?"#DC2626":"#7C0000")}} onClick={function(){setViewing(r);}}>
                    <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                      <div style={{flex:1}}>
                        <div style={{...S.row,gap:8,marginBottom:4}}>
                          <span style={{fontSize:13,fontWeight:700,color:C.primaryDark}}>{r.studentName}</span>
                          <span style={S.badge("blue")}>{r.class}</span>
                          <span style={S.badge(r.severity==="Minor"?"yellow":r.severity==="Moderate"?"red":"red")}>{r.severity}</span>
                          <span style={S.badge(r.status==="Resolved"?"green":r.status==="Open"?"red":"yellow")}>{r.status}</span>
                        </div>
                        <div style={{fontSize:12,fontWeight:600,marginBottom:2}}>{r.incidentType}</div>
                        <div style={{fontSize:11,color:C.textMuted}}>{r.description.slice(0,100)}{r.description.length>100?"...":""}</div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div style={{fontSize:12,fontWeight:700,color:C.danger}}>{formatDate(r.date)}</div>
                        <div style={{fontSize:10,color:C.textMuted}}>{r.reportedBy}</div>
                      </div>
                    </div>
                  </div>
                );
              })
            )
          )}

          {showForm ? (
            <Modal open={showForm} onClose={function(){setShowForm(false);}} title="Log Disciplinary Incident" wide>
              <div style={S.grid2}>
                <div style={S.formGroup}>
                  <label style={S.label}>Student *</label>
                  <select style={{...S.select,width:"100%"}} value={form.studentId} onChange={function(e){setForm(function(p){return{...p,studentId:e.target.value};});}}>
                    <option value="">— Select Student —</option>
                    {students.filter(function(s){return s.active;}).sort(function(a,b){return (a.class+a.surname).localeCompare(b.class+b.surname);}).map(function(s){return <option key={s.id} value={s.id}>{s.class}{s.arm||""} — {s.surname} {s.firstname}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}><label style={S.label}>Date</label><input type="date" style={S.input} value={form.date} onChange={function(e){setForm(function(p){return{...p,date:e.target.value};});}}/></div>
                <div style={S.formGroup}>
                  <label style={S.label}>Incident Type *</label>
                  <select style={{...S.select,width:"100%"}} value={form.incidentType} onChange={function(e){setForm(function(p){return{...p,incidentType:e.target.value};});}}>
                    {INCIDENT_TYPES.map(function(t){return <option key={t}>{t}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Severity</label>
                  <select style={{...S.select,width:"100%"}} value={form.severity} onChange={function(e){setForm(function(p){return{...p,severity:e.target.value};});}}>
                    {SEVERITIES.map(function(s){return <option key={s}>{s}</option>;})}
                  </select>
                </div>
                <div style={{...S.formGroup,gridColumn:"1/-1"}}><label style={S.label}>Description of Incident *</label><textarea style={{...S.textarea,minHeight:80}} value={form.description} onChange={function(e){setForm(function(p){return{...p,description:e.target.value};});}} placeholder="Describe exactly what happened, when and where..."/></div>
                <div style={S.formGroup}><label style={S.label}>Location</label><input style={S.input} value={form.location} onChange={function(e){setForm(function(p){return{...p,location:e.target.value};});}} placeholder="Classroom, compound, dormitory..."/></div>
                <div style={S.formGroup}><label style={S.label}>Witnesses</label><input style={S.input} value={form.witnesses} onChange={function(e){setForm(function(p){return{...p,witnesses:e.target.value};});}} placeholder="Names of witnesses if any"/></div>
                <div style={S.formGroup}>
                  <label style={S.label}>Action Taken</label>
                  <select style={{...S.select,width:"100%"}} value={form.actionTaken} onChange={function(e){setForm(function(p){return{...p,actionTaken:e.target.value};});}}>
                    {ACTIONS.map(function(a){return <option key={a}>{a}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Status</label>
                  <select style={{...S.select,width:"100%"}} value={form.status} onChange={function(e){setForm(function(p){return{...p,status:e.target.value};});}}>
                    {STATUSES.map(function(s){return <option key={s}>{s}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}><label style={S.label}>Follow-up Date</label><input type="date" style={S.input} value={form.followUpDate} onChange={function(e){setForm(function(p){return{...p,followUpDate:e.target.value};});}}/></div>
                <div style={S.formGroup}><label style={S.label}>Reported By</label><input style={S.input} value={form.reportedBy} onChange={function(e){setForm(function(p){return{...p,reportedBy:e.target.value};});}}/></div>
                <div style={{...S.formGroup,gridColumn:"1/-1"}}><label style={S.label}>Resolution (if resolved)</label><textarea style={{...S.textarea,minHeight:60}} value={form.resolution} onChange={function(e){setForm(function(p){return{...p,resolution:e.target.value};});}} placeholder="How was the matter resolved?"/></div>
                <div style={{...S.formGroup,gridColumn:"1/-1"}}>
                  <label style={{...S.row,gap:8,cursor:"pointer"}}>
                    <input type="checkbox" checked={form.parentNotified} onChange={function(){setForm(function(p){return{...p,parentNotified:!p.parentNotified};});}}/>
                    <span style={{fontSize:12}}>Notify parent via SMS immediately on save</span>
                  </label>
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:14}}>
                <button style={S.btn("secondary")} onClick={function(){setShowForm(false);}}>Cancel</button>
                <button style={S.btn()} onClick={save}>Save Incident Record</button>
              </div>
            </Modal>
          ) : null}
        </div>
      ) : null}

      {tab==="stats" ? (
        <div>
          <div style={S.statsGrid}>
            {[{l:"This Term",v:thisTermCases.length,bg:"#FFF7ED"},{l:"Open Cases",v:openCases.length,bg:"#FEF2F2"},{l:"Serious/Critical",v:severeCases.length,bg:"#FEE2E2"},{l:"Total All Time",v:conduct.length,bg:"#F5F3FB"}].map(function(s,i){
              return <div key={i} style={S.statCard(s.bg)}><div style={{...S.statNum,fontSize:20}}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>;
            })}
          </div>
          <div style={S.card}>
            <div style={S.cardTitle}>Most Common Incident Types This Term</div>
            {topTypes.length===0?<div style={{color:C.textMuted,fontSize:12,padding:12}}>No incidents this term.</div>:topTypes.map(function(entry,i){
              var max=topTypes[0][1];
              return(
                <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderBottom:"1px solid "+C.border}}>
                  <div style={{width:160,fontSize:11,fontWeight:600}}>{entry[0]}</div>
                  <div style={{flex:1,height:14,background:"#F3F4F6",borderRadius:6,overflow:"hidden"}}><div style={{height:"100%",width:(entry[1]/max*100)+"%",background:"#DC2626",borderRadius:6}}/></div>
                  <div style={{width:24,fontSize:12,fontWeight:700,color:"#DC2626"}}>{entry[1]}</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}


function SMSTestWidget(){
  var _phone = useState(""); var testPhone = _phone[0]; var setTestPhone = _phone[1];
  var _msg = useState(""); var testMsg = _msg[0]; var setTestMsg = _msg[1];
  var _sending = useState(false); var sending = _sending[0]; var setSending = _sending[1];
  var _result = useState(null); var result = _result[0]; var setResult = _result[1];

  async function sendTest(){
    if(!testPhone) return alert("Enter a phone number to test.");
    if(!testMsg) return alert("Enter a message.");
    setSending(true); setResult(null);
    var res = await sendSMS(testPhone, testMsg, "Test SMS");
    setSending(false);
    setResult(res);
  }

  return(
    <div>
      <div style={S.grid2}>
        <div style={S.formGroup}>
          <label style={S.label}>Test Phone Number</label>
          <input style={S.input} placeholder="08012345678" value={testPhone} onChange={function(e){setTestPhone(e.target.value);}}/>
        </div>
        <div style={S.formGroup}>
          <label style={S.label}>Test Message</label>
          <input style={S.input} placeholder="Test SMS from Assanusiyyah SIS" value={testMsg} onChange={function(e){setTestMsg(e.target.value);}}/>
        </div>
      </div>
      <button style={{...S.btn(sending?"secondary":"blue"),opacity:sending?0.7:1}} onClick={sendTest} disabled={sending}>
        {sending ? "⏳ Sending..." : "📤 Send Test SMS"}
      </button>
      {result ? (
        <div style={{marginTop:10,padding:"8px 12px",borderRadius:6,background:result.success?"#D1FAE5":"#FEE2E2",color:result.success?"#065F46":"#991B1B",fontSize:12,fontWeight:600}}>
          {result.success ? "✅ SMS delivered successfully!" : "❌ Failed: "+(result.error||"Unknown error")}
        </div>
      ) : null}
      <div style={{marginTop:10,fontSize:11,color:C.textMuted}}>
        SMS Balance: check your Termii dashboard at <b>app.termii.com</b> · Sender: <b>ASSANUSIYYA</b>
      </div>
    </div>
  );
}

function SettingsModule({settings,setSettings,currentUser,setCurrentUser}){
  // Wrap setSettings to backup critical data to localStorage on every save
  function setSettingsSafe(valOrFn){
    setSettings(function(prev){
      var next = typeof valOrFn==="function" ? valOrFn(prev) : valOrFn;
      try{
        // Backup images to localStorage
        if(next.schoolLogo) localStorage.setItem("asis_schoolLogo", next.schoolLogo);
        if(next.schoolStamp) localStorage.setItem("asis_schoolStamp", next.schoolStamp);
        if(next.signature) localStorage.setItem("asis_signature", next.signature);
      } catch(ex){}
      return next;
    });
  }
  const [tab,setTab]=useState("general");
  const [stampRef]=useState(()=>({current:null}));
  const [sigRef]=useState(()=>({current:null}));
  const [calForm,setCalForm]=useState({title:"",date:"",type:"Academic"});
  const [adminForm,setAdminForm]=useState({name:"",username:"",password:"",role:"Teacher",permissions:[],active:true});
  const [showAdminForm,setShowAdminForm]=useState(false);
  const [editingAdmin,setEditingAdmin]=useState(null);
  // Shown once right after a password is set/reset — never stored, just the
  // value the admin already typed, echoed back so they can copy it down.
  const [revealInfo,setRevealInfo]=useState(null);
  const [extraClass,setExtraClass]=useState("");
  const [extraSub,setExtraSub]=useState("");
  const isRoot=currentUser?.role==="root";
  const [rcForm,setRcForm]=useState(getResultConfig(settings));
  useEffect(function(){ if(tab==="resultconfig") setRcForm(getResultConfig(settings)); },[tab]);

  // Admin accounts now live only behind the authenticated /api/admin endpoint —
  // never in settings, never in the generic /api/db proxy (see admin.js).
  const [admins,setAdmins]=useState([]);
  const [adminsLoading,setAdminsLoading]=useState(true);
  function reloadAdmins(){
    setAdminsLoading(true);
    adminCall({action:"list"}).then(function(res){
      setAdmins(res&&res.success?(res.admins||[]).filter(function(a){return a.username!=="root";}):[]);
      setAdminsLoading(false);
    });
  }
  useEffect(function(){ reloadAdmins(); },[]);

  function uploadFile(e,field){
  const file=e.target.files[0];
  if(!file) return;
  if(file.size > 200000){ alert("Image too large. Please use an image under 200KB.\nTip: Compress your image at tinypng.com first."); return; }
  const r=new FileReader();
  r.onload=function(ev){
    const dataUrl=ev.target.result;
    // 1. Save to localStorage immediately (fast, works offline)
    try{ localStorage.setItem("asis_"+field, dataUrl); }catch(ex){}
    // 2. Update React state so it shows on screen right away
    setSettings(function(p){ return {...p,[field]:dataUrl}; });
    // 3. Save to Supabase school_assets table
    sbUpsertRow("school_assets", field, {field:field, value:dataUrl}).catch(function(){});
    console.log(field+" uploaded ("+Math.round(dataUrl.length/1024)+"KB)");
  };
  r.readAsDataURL(file);
}
  function addCalEvent(){if(!calForm.title||!calForm.date)return alert("Title and date required.");setSettingsSafe(p=>({...p,calendarEvents:[...p.calendarEvents,{...calForm,id:genId()}]}));setCalForm({title:"",date:"",type:"Academic"});}
  function removeCalEvent(id){setSettingsSafe(p=>({...p,calendarEvents:p.calendarEvents.filter(e=>e.id!==id)}));}
  function addExtraClass(){if(!extraClass.trim())return;setSettingsSafe(p=>({...p,extraClasses:[...(p.extraClasses||[]),extraClass.trim()]}));setExtraClass("");}
  function addExtraSub(){if(!extraSub.trim())return;setSettingsSafe(p=>({...p,extraSubjects:[...(p.extraSubjects||[]),extraSub.trim()]}));setExtraSub("");}

  return(<div>
    <div style={{...S.card,background:"linear-gradient(135deg,#160946,#230E6A)",marginBottom:14,...S.row,gap:14}}>
      <SchoolLogoImg size={52}/>
      <div>
        <div style={{fontSize:14,fontWeight:800,color:C.goldLight}}>{SCHOOL_NAME}</div>
        <div style={{fontSize:10,color:"rgba(255,255,255,0.6)"}}>{SCHOOL_ADDRESS}</div>
        <div style={{fontSize:10,color:C.goldLight,marginTop:2}}>{SCHOOL_MOTTO}</div>
      </div>
      <div style={{marginLeft:"auto",textAlign:"right"}}>
        <div style={{...S.badge("gold"),fontSize:11}}>Logged in as: {currentUser?.name||"Root Admin"}</div>
        <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",marginTop:4}}>{isRoot?"Root Access — Full Control":"Limited Access"}</div>
      </div>
    </div>

    <Tabs tabs={[["general","General"],["admins","Admin Accounts"],["calendar","Calendar"],["classes","Classes & Subjects"],...(isRoot?[["resultconfig","Result Sheet Config"]]:[])]} active={tab} onChange={setTab}/>

    {tab==="general"&&<div>
      <div style={S.grid2}>
        <div style={S.card}>
          <div style={S.cardTitle}>Admin Notification Phone</div>
          <div style={S.formGroup}><label style={S.label}>Phone Number (receives absence & other alerts)</label><input style={S.input} value={settings.adminPhone||""} onChange={e=>setSettingsSafe(p=>({...p,adminPhone:e.target.value}))}/></div>
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>📱 SMS Configuration (Termii)</div>
          <div style={{fontSize:12,color:C.textMuted,marginBottom:10}}>Your school SMS is powered by Termii. Sender ID: <b>ASSANUSIYYA</b>. All fee receipts, absence alerts, birthday messages and announcements are sent automatically.</div>
          <SMSTestWidget/>
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>🖼️ School Logo</div>
          <div style={{marginBottom:10}}>
            {settings.schoolLogo
              ? <img src={settings.schoolLogo} alt="School Logo" style={{width:80,height:80,objectFit:"contain",marginBottom:8,background:"#F5F3FB",borderRadius:8,padding:4}}/>
              : <div style={{width:80,height:80,background:"#F5F3FB",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8}}>
                  <span style={{fontSize:24,fontWeight:900,color:"#230E6A"}}>AS</span>
                </div>
            }
          </div>
          {isRoot&&<button style={S.btn()} onClick={()=>document.getElementById("logoUpload").click()}>Upload School Logo</button>}
          {settings.schoolLogo&&isRoot&&<button style={{...S.btn("danger"),marginLeft:8}} onClick={()=>setSettingsSafe(p=>({...p,schoolLogo:""}))}>Remove</button>}
          <input id="logoUpload" type="file" accept="image/*" style={{display:"none"}} onChange={e=>uploadFile(e,"schoolLogo")}/>
          <div style={{fontSize:10,color:C.textMuted,marginTop:6}}>Your logo appears on ID cards, the login screen, report headers and the sidebar. PNG or JPG with transparent background works best.</div>
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>School Stamp</div>
          {settings.schoolStamp&&<img src={settings.schoolStamp} alt="Stamp" style={{width:80,height:80,objectFit:"contain",marginBottom:8}}/>}
          {isRoot&&<button style={S.btn("secondary")} onClick={()=>document.getElementById("stampUpload").click()}>Upload Stamp</button>}
          <input id="stampUpload" type="file" accept="image/*" style={{display:"none"}} onChange={e=>uploadFile(e,"schoolStamp")}/>
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>Principal's Signature</div>
          {settings.signature&&<img src={settings.signature} alt="Sig" style={{width:120,height:50,objectFit:"contain",marginBottom:8}}/>}
          {isRoot&&<button style={S.btn("secondary")} onClick={()=>document.getElementById("sigUpload").click()}>Upload Signature</button>}
          <input id="sigUpload" type="file" accept="image/*" style={{display:"none"}} onChange={e=>uploadFile(e,"signature")}/>
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>System Info</div>
          <div style={{fontSize:12,color:C.textMuted}}>SIS v3.0 — Assanusiyyah Group of Schools</div>
          <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>Current Session: {CURRENT_SESSION}</div>
          <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>Current Term: {CURRENT_TERM}</div>
          {!isRoot&&<div style={{...S.badge("yellow"),marginTop:8,display:"inline-block"}}>Read/Write access only</div>}
        </div>
      </div>

      {/* Save Settings Button */}
      {isRoot&&<div style={{...S.card,background:"#F0FDF4",border:"1px solid #BBF7D0",marginTop:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#065F46"}}>💾 Save All Settings</div>
            <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>Click to save school name, logo, stamp, signature and all settings to the database.</div>
          </div>
          <button style={{...S.btn("green"),padding:"10px 24px",fontSize:13}} onClick={function(){
            // Save settings to Supabase (images are already in localStorage)
            var toSave = {...settings, schoolLogo:"", schoolStamp:"", signature:""};
            setSettings(function(){return {...settings};});
            alert("✅ Settings saved! Your logo, stamp and signature are stored in this browser and will appear automatically.");
          }}>💾 Save Settings</button>
        </div>
      </div>}
    </div>}

    {tab==="admins"&&<div>
      {!isRoot&&<div style={{...S.card,border:"2px solid "+C.danger,marginBottom:14}}>
        <div style={{color:C.danger,fontWeight:600,fontSize:12}}>🔒 Only root admin can manage user accounts.</div>
      </div>}

      {isRoot&&<div>
        {/* Stats strip */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
          {[
            {l:"Total Accounts",v:admins.length+1,bg:"#F5F3FB"},
            {l:"Admins",v:admins.filter(function(a){return a.role==="Admin";}).length,bg:"#EFF6FF"},
            {l:"Teachers",v:admins.filter(function(a){return a.role==="Teacher";}).length,bg:"#F0FDF4"},
            {l:"Others",v:admins.filter(function(a){return a.role!=="Admin"&&a.role!=="Teacher";}).length,bg:"#FFF7ED"},
          ].map(function(s,i){
            return <div key={i} style={{...S.statCard(s.bg),padding:"10px 12px"}}><div style={{fontSize:20,fontWeight:900}}>{s.v}</div><div style={{fontSize:10,color:C.textMuted}}>{s.l}</div></div>;
          })}
        </div>

        {/* Action bar */}
        <div style={{...S.card,marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
          <div style={{fontSize:13,fontWeight:700,color:C.primaryDark}}>👤 User Accounts</div>
          <button style={S.btn()} onClick={function(){setAdminForm({name:"",username:"",password:"",role:"Teacher",permissions:[],active:true});setShowAdminForm(true);}}>+ Add New User</button>
        </div>

        {/* Root account row */}
        <div style={{...S.card,marginBottom:10,borderLeft:"4px solid #D97706",background:"#FFFBEB"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              <div style={{width:40,height:40,borderRadius:"50%",background:"#D97706",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:900,fontSize:16}}>R</div>
              <div>
                <div style={{fontSize:13,fontWeight:700}}>{currentUser.name||"Root Administrator"}</div>
                <div style={{fontSize:11,color:C.textMuted}}>Username: {currentUser.username||"root"} · Full system access</div>
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <span style={{...S.badge("yellow"),fontSize:11}}>ROOT</span>
              <span style={{...S.badge("green"),fontSize:10}}>Active</span>
              <button onClick={function(){
                setAdminForm({id:"ADM001", name:currentUser.name||"Root Administrator", username:currentUser.username||"root", newPassword:"", role:"root", permissions:["all"], active:true});
                setEditingAdmin("ADM001");
                setShowAdminForm(true);
              }} style={{...S.btn("blue"),fontSize:10,padding:"3px 10px"}}>✏️ Edit</button>
            </div>
          </div>
        </div>

        {/* Staff accounts */}
        {adminsLoading ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>Loading accounts…</div>
        ) : admins.length===0 ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>
            <div style={{fontSize:32,marginBottom:8}}>👥</div>
            <div style={{fontSize:13,fontWeight:600}}>No additional user accounts yet</div>
            <div style={{fontSize:12,marginTop:4}}>Click "+ Add New User" to create accounts for your staff</div>
          </div>
        ) : admins.map(function(a){
          var initials = (a.name||"?").split(" ").map(function(w){return w[0];}).join("").slice(0,2).toUpperCase();
          var roleColor = a.role==="Admin"?"#1D4ED8":a.role==="Teacher"?"#059669":a.role==="Bursar"?"#D97706":"#7C3AED";
          return(
            <div key={a.id} style={{...S.card,marginBottom:10,borderLeft:"4px solid "+roleColor,opacity:(a.active===false)?0.6:1}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
                <div style={{display:"flex",gap:12,alignItems:"center",flex:1}}>
                  <div style={{width:40,height:40,borderRadius:"50%",background:roleColor,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:900,fontSize:14,flexShrink:0}}>{initials}</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:700}}>{a.name}</div>
                    <div style={{fontSize:11,color:C.textMuted}}>Username: <b>{a.username}</b></div>
                    <div style={{fontSize:10,color:C.textMuted,marginTop:3}}>
                      Permissions: {(a.permissions||[]).length===0?"None set":a.permissions.includes("all")?"All modules":(a.permissions||[]).join(", ")}
                    </div>
                  </div>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  <span style={{...S.badge(a.role==="Admin"?"blue":a.role==="Teacher"?"green":"yellow"),fontSize:10}}>{a.role}</span>
                  <span style={{...S.badge(a.active===false?"red":"green"),fontSize:10}}>{a.active===false?"Inactive":"Active"}</span>
                  <button onClick={function(){
                    setAdminForm({...a, newPassword:""});
                    setShowAdminForm(true);
                    setEditingAdmin(a.id);
                  }} style={{...S.btn("blue"),fontSize:10,padding:"3px 10px"}}>✏️ Edit</button>
                  <button onClick={function(){
                    adminCall({action:"upsert", admin:{id:a.id, active:a.active===false?true:false}}).then(function(res){
                      if(res&&res.success) reloadAdmins();
                      else alert("Could not update account. Please try again.");
                    });
                  }} style={{...S.btn("secondary"),fontSize:10,padding:"3px 10px"}}>
                    {a.active===false?"✅ Activate":"⏸ Deactivate"}
                  </button>
                  <button onClick={function(){
                    if(window.confirm("Delete account for "+a.name+"? This cannot be undone.")){
                      adminCall({action:"delete", id:a.id}).then(function(res){
                        if(res&&res.success) reloadAdmins();
                        else alert("Could not delete account. Please try again.");
                      });
                    }
                  }} style={{...S.btn("danger"),fontSize:10,padding:"3px 10px"}}>🗑 Delete</button>
                </div>
              </div>

              {/* Permission pills */}
              {(a.permissions||[]).length>0&&!a.permissions.includes("all")&&(
                <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:10,paddingTop:10,borderTop:"1px solid "+C.border}}>
                  <span style={{fontSize:10,color:C.textMuted,marginRight:4}}>Can access:</span>
                  {(a.permissions||[]).map(function(p){
                    return <span key={p} style={{...S.badge("blue"),fontSize:9,padding:"2px 7px"}}>{p}</span>;
                  })}
                </div>
              )}
              {(a.permissions||[]).includes("all")&&(
                <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid "+C.border,fontSize:10,color:"#059669",fontWeight:600}}>✅ Full access to all modules</div>
              )}
            </div>
          );
        })}

        {/* Add/Edit User Modal */}
        {showAdminForm&&(
          <Modal open={showAdminForm} onClose={function(){setShowAdminForm(false);setEditingAdmin(null);}} title={editingAdmin==="ADM001"?"Edit Root Account":(editingAdmin?"Edit User Account":"Create New User Account")} wide>
            <div style={S.grid2}>
              <div style={S.formGroup}>
                <label style={S.label}>Full Name *</label>
                <input style={S.input} value={adminForm.name} onChange={function(e){setAdminForm(function(p){return{...p,name:e.target.value};});}} placeholder="e.g. Aisha Adebayo"/>
              </div>
              <div style={S.formGroup}>
                <label style={S.label}>Username * <span style={{fontSize:10,color:C.textMuted}}>(used to log in)</span></label>
                <input style={S.input} value={adminForm.username} onChange={function(e){setAdminForm(function(p){return{...p,username:e.target.value.toLowerCase().replace(/\s/g,"")};});}} placeholder="e.g. aisha.adebayo"/>
              </div>
              <div style={S.formGroup}>
                <label style={S.label}>{editingAdmin?"New Password":"Password *"} <span style={{fontSize:10,color:C.textMuted}}>{editingAdmin?"(leave blank to keep current)":""}</span></label>
                <input style={S.input} type="password" value={adminForm.newPassword||adminForm.password||""} onChange={function(e){setAdminForm(function(p){return{...p,newPassword:e.target.value,password:e.target.value};});}} placeholder={editingAdmin?"Leave blank to keep current":"Set a strong password"}/>
              </div>
              {editingAdmin!=="ADM001"&&(
                <div style={S.formGroup}>
                  <label style={S.label}>Role *</label>
                  <select style={{...S.select,width:"100%"}} value={adminForm.role} onChange={function(e){setAdminForm(function(p){return{...p,role:e.target.value};});}}>
                    {["Admin","Teacher","Bursar","Nurse","Counsellor","Clerk","Librarian"].map(function(r){return <option key={r}>{r}</option>;})}
                  </select>
                </div>
              )}
            </div>

            {editingAdmin==="ADM001" ? (
              <div style={{marginTop:14,...S.card,background:"#FFFBEB",border:"1px solid #D97706"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#92400E"}}>🔑 Root always has full access to every module.</div>
                <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>Role and permissions can't be changed here — only name, username, and password.</div>
              </div>
            ) : (<>
            {/* Permissions */}
            <div style={{marginTop:14}}>
              <div style={{fontSize:12,fontWeight:700,color:C.primaryDark,marginBottom:10}}>Module Access Permissions</div>
              <label style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,cursor:"pointer",fontSize:12}}>
                <input type="checkbox"
                  checked={(adminForm.permissions||[]).includes("all")}
                  onChange={function(){
                    setAdminForm(function(p){
                      var hasAll = (p.permissions||[]).includes("all");
                      return{...p,permissions:hasAll?[]:["all"]};
                    });
                  }}
                />
                <span style={{fontWeight:700,color:"#059669"}}>✅ Grant access to ALL modules</span>
              </label>

              {!(adminForm.permissions||[]).includes("all")&&(
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:6}}>
                  {[
                    ["dashboard","📊 Dashboard"],["analytics","📈 Analytics"],
                    ["students","👨‍🎓 Students"],["attendance","✅ Attendance"],
                    ["results","📋 Results"],["exams","📝 Exams"],
                    ["lessons","📖 Lessons"],["studentportal","🎓 Student Portal"],
                    ["elibrary","📚 E-Library"],["fees","💰 Fees & Finance"],
                    ["clinic","🏥 Clinic"],["staff","👩‍💼 Staff"],
                    ["timetable","🗓 Timetable"],["idcards","🪪 ID Cards"],
                    ["diary","📔 Diary"],["payroll","💵 Payroll"],
                    ["calendar","📅 Period Planner"],["alumni","🎓 Alumni"],
                    ["admissions","📝 Admissions"],["gallery","🖼 Gallery"],
                    ["messages","💬 Messages"],["welfare","⚠️ Welfare"],
                    ["counsellor","💚 Counsellor"],["settings","⚙️ Settings"],
                  ].map(function(pair){
                    var hasPermission = (adminForm.permissions||[]).includes(pair[0]);
                    return(
                      <label key={pair[0]} style={{display:"flex",gap:6,alignItems:"center",cursor:"pointer",padding:"5px 8px",borderRadius:6,background:hasPermission?"#EFF6FF":"#F9FAFB",border:"1px solid "+(hasPermission?"#1D4ED8":"#E5E7EB"),fontSize:11}}>
                        <input type="checkbox" checked={hasPermission} onChange={function(){
                          setAdminForm(function(p){
                            var perms = p.permissions||[];
                            return{...p,permissions:perms.includes(pair[0])?perms.filter(function(x){return x!==pair[0];}):[ ...perms,pair[0]]};
                          });
                        }}/>
                        {pair[1]}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Quick permission presets */}
            <div style={{marginTop:12}}>
              <div style={{fontSize:11,fontWeight:700,color:C.textMuted,marginBottom:6}}>Quick Presets:</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {[
                  {label:"Class Teacher",perms:["dashboard","students","attendance","results","lessons","studentportal","messages"]},
                  {label:"Bursar",perms:["dashboard","students","fees","messages"]},
                  {label:"Nurse",perms:["dashboard","students","clinic","messages"]},
                  {label:"Counsellor",perms:["dashboard","students","counsellor","welfare","messages"]},
                  {label:"HOD / Senior Teacher",perms:["dashboard","analytics","students","attendance","results","exams","lessons","studentportal","elibrary","timetable","messages"]},
                ].map(function(preset){
                  return <button key={preset.label} type="button" onClick={function(){setAdminForm(function(p){return{...p,permissions:preset.perms};});}} style={{...S.badge("blue"),cursor:"pointer",padding:"4px 10px",fontSize:10,border:"1px solid #1D4ED8"}}>{preset.label}</button>;
                })}
              </div>
            </div>
            </>)}

            <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:16}}>
              <button style={S.btn("secondary")} onClick={function(){setShowAdminForm(false);setEditingAdmin(null);}}>Cancel</button>
              <button style={S.btn()} onClick={function(){
                if(!adminForm.name||!adminForm.username)return alert("Name and username are required.");
                if(!editingAdmin&&!adminForm.password)return alert("Password is required for new accounts.");
                if(admins.find(function(a){return a.username===adminForm.username&&a.id!==editingAdmin;}))return alert("Username already taken. Choose another.");

                var isRootEdit = editingAdmin==="ADM001";
                var payload = {
                  id: editingAdmin||undefined,
                  name: adminForm.name,
                  username: adminForm.username,
                  role: isRootEdit?"root":adminForm.role,
                  permissions: isRootEdit?["all"]:(adminForm.permissions||[]),
                  active: isRootEdit?true:(adminForm.active!==false),
                };
                var newPlainPassword = adminForm.newPassword||adminForm.password||"";
                if(newPlainPassword) payload.newPassword = newPlainPassword;

                adminCall({action:"upsert", admin:payload}).then(function(res){
                  if(res&&res.success){
                    if(isRootEdit && setCurrentUser) setCurrentUser(res.admin);
                    reloadAdmins();
                    setShowAdminForm(false);
                    setEditingAdmin(null);
                    setAdminForm({name:"",username:"",password:"",role:"Teacher",permissions:[],active:true});
                    if(newPlainPassword){
                      setRevealInfo({username:payload.username, password:newPlainPassword, isNew:!editingAdmin});
                    } else {
                      alert("✅ Account updated.");
                    }
                  } else {
                    alert("⚠️ "+((res&&res.error)||"Could not save account. Please try again."));
                  }
                });
              }}>{editingAdmin?"Save Changes":"Create Account"}</button>
            </div>
          </Modal>
        )}

        {/* Shown once right after a password is set/reset — the value is never
            stored anywhere, only echoed back from what was just typed. */}
        {revealInfo&&(
          <Modal open={true} onClose={function(){setRevealInfo(null);}} title={revealInfo.isNew?"Account Created":"Password Updated"}>
            <div style={{fontSize:12,color:C.textMuted,marginBottom:12}}>
              Share this with the account holder now — for security, it will not be shown again. To look it up later, reset the password instead.
            </div>
            <div style={{...S.card,background:"#F5F3FB",display:"flex",flexDirection:"column",gap:10}}>
              <div>
                <div style={{fontSize:10,color:C.textMuted,fontWeight:600}}>USERNAME</div>
                <div style={{fontSize:15,fontWeight:800}}>{revealInfo.username}</div>
              </div>
              <div>
                <div style={{fontSize:10,color:C.textMuted,fontWeight:600}}>PASSWORD</div>
                <div style={{fontSize:15,fontWeight:800,fontFamily:"monospace",letterSpacing:"0.03em"}}>{revealInfo.password}</div>
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:16}}>
              <button style={S.btn()} onClick={function(){
                try{ navigator.clipboard.writeText(revealInfo.username+" / "+revealInfo.password); }catch(ex){}
                setRevealInfo(null);
              }}>📋 Copy & Close</button>
            </div>
          </Modal>
        )}
      </div>}
    </div>}

    {tab==="calendar"&&<div>
      <div style={S.card}>
        <div style={S.cardTitle}>Add Calendar Event</div>
        <div style={S.grid3}>
          <div style={S.formGroup}><label style={S.label}>Event Title</label><input style={S.input} value={calForm.title} onChange={e=>setCalForm(p=>({...p,title:e.target.value}))}/></div>
          <div style={S.formGroup}><label style={S.label}>Date</label><input style={S.input} type="date" value={calForm.date} onChange={e=>setCalForm(p=>({...p,date:e.target.value}))}/></div>
          <div style={S.formGroup}><label style={S.label}>Type</label><select style={{...S.select,width:"100%"}} value={calForm.type} onChange={e=>setCalForm(p=>({...p,type:e.target.value}))}>{["Academic","Exam","Holiday","Event","Others"].map(o=><option key={o}>{o}</option>)}</select></div>
        </div>
        <button style={S.btn()} onClick={addCalEvent}><span style={S.row}><Icon name="plus" size={13}/>Add Event</span></button>
      </div>
      <div style={S.card}>
        <div style={S.cardTitle}>School Calendar Events</div>
        <table style={S.table}><thead><tr>{["Event","Date","Type","Action"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
        <tbody>
          {settings.calendarEvents.sort((a,b)=>a.date.localeCompare(b.date)).map(e=>(
            <tr key={e.id} style={{background:e.date<today()?"#FAFAFA":C.white}}>
              <td style={{...S.td,fontWeight:600,color:e.date<today()?C.textMuted:C.text}}>{e.title}</td>
              <td style={S.td}>{formatDate(e.date)}</td>
              <td style={S.td}><span style={S.badge(e.type==="Exam"?"red":e.type==="Holiday"?"yellow":e.type==="Academic"?"green":"blue")}>{e.type}</span></td>
              <td style={S.td}><button style={{...S.btn("danger"),fontSize:10,padding:"3px 7px"}} onClick={()=>removeCalEvent(e.id)}>Remove</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>}

    {tab==="classes"&&<div>
      <div style={S.grid2}>
        <div style={S.card}>
          <div style={S.cardTitle}>Custom Classes</div>
          <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>Default classes: {CLASSES.join(", ")}</div>
          <div style={S.row}>
            <input style={{...S.input,flex:1}} placeholder="e.g. Nursery 1" value={extraClass} onChange={e=>setExtraClass(e.target.value)}/>
            <button style={S.btn()} onClick={addExtraClass}>Add</button>
          </div>
          {(settings.extraClasses||[]).length>0&&<div style={{marginTop:10,display:"flex",flexWrap:"wrap",gap:6}}>{(settings.extraClasses||[]).map(c=><div key={c} style={{...S.badge("blue"),padding:"4px 10px",...S.row}}>{c}<button style={{background:"none",border:"none",cursor:"pointer",color:C.danger,marginLeft:4,fontSize:12}} onClick={()=>setSettingsSafe(p=>({...p,extraClasses:p.extraClasses.filter(x=>x!==c)}))}>×</button></div>)}</div>}
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>Custom Subjects</div>
          <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>Add subjects not in the default list.</div>
          <div style={S.row}>
            <input style={{...S.input,flex:1}} placeholder="e.g. Hausa Language" value={extraSub} onChange={e=>setExtraSub(e.target.value)}/>
            <button style={S.btn()} onClick={addExtraSub}>Add</button>
          </div>
          {(settings.extraSubjects||[]).length>0&&<div style={{marginTop:10,display:"flex",flexWrap:"wrap",gap:6}}>{(settings.extraSubjects||[]).map(s=><div key={s} style={{...S.badge("green"),padding:"4px 10px",...S.row}}>{s}<button style={{background:"none",border:"none",cursor:"pointer",color:C.danger,marginLeft:4,fontSize:12}} onClick={()=>setSettingsSafe(p=>({...p,extraSubjects:p.extraSubjects.filter(x=>x!==s)}))}>×</button></div>)}</div>}
        </div>
      </div>
    </div>}

    {isRoot&&tab==="resultconfig"&&<div>
      <div style={{...S.card,marginBottom:14,background:"#FFFBEB",border:"1px solid #F0C060"}}>
        <div style={{fontSize:12,color:"#92400E"}}>🔑 Root-only. These settings control how CA/Exam scores are entered and how every report card is graded, laid out and released to parents.</div>
      </div>

      <div style={{...S.card,marginBottom:14}}>
        <div style={S.cardTitle}>Result Visibility to Students/Parents</div>
        <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>Controls {CURRENT_TERM} {CURRENT_SESSION}. Older terms stay visible unless separately hidden.</div>
        {(function(){
          var key = CURRENT_SESSION+"_"+CURRENT_TERM;
          var published = (settings.resultsPublished||{})[key] !== false;
          return(
            <div style={{...S.row,justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
              <span style={S.badge(published?"green":"red")}>{published?"🟢 Published — visible to parents":"🔒 Hidden from parents"}</span>
              <button style={S.btn(published?"danger":"green")} onClick={function(){
                setSettingsSafe(function(p){
                  var rp = {...(p.resultsPublished||{})};
                  rp[key] = !published;
                  return {...p, resultsPublished:rp};
                });
              }}>{published?"Hide Results Now":"Publish Results Now"}</button>
            </div>
          );
        })()}
      </div>

      <div style={{...S.card,marginBottom:14}}>
        <div style={S.cardTitle}>Score Columns (Max Marks)</div>
        <div style={S.grid3}>
          <div style={S.formGroup}><label style={S.label}>CA1 Max</label><input type="number" style={S.input} value={rcForm.ca1Max} onChange={e=>setRcForm(p=>({...p,ca1Max:parseInt(e.target.value)||0}))}/></div>
          <div style={S.formGroup}><label style={S.label}>CA2 Max</label><input type="number" style={S.input} value={rcForm.ca2Max} onChange={e=>setRcForm(p=>({...p,ca2Max:parseInt(e.target.value)||0}))}/></div>
          <div style={S.formGroup}><label style={S.label}>Exam Max</label><input type="number" style={S.input} value={rcForm.examMax} onChange={e=>setRcForm(p=>({...p,examMax:parseInt(e.target.value)||0}))}/></div>
        </div>
        <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>Total = {rcForm.ca1Max+rcForm.ca2Max+rcForm.examMax}. Changing these does not rescale scores already entered.</div>
      </div>

      <div style={{...S.card,marginBottom:14}}>
        <div style={S.cardTitle}>Pass Mark</div>
        <input type="number" style={{...S.input,width:120}} value={rcForm.passMark} onChange={e=>setRcForm(p=>({...p,passMark:parseInt(e.target.value)||0}))}/>
        <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>Used in Analytics, Broadsheet colouring, Parent Portal, Counsellor flags, and the "assign to below-pass-mark students" tool in Results → Score Entry.</div>
      </div>

      <div style={{...S.card,marginBottom:14}}>
        <div style={S.cardTitle}>Grading Scale</div>
        <table style={S.table}>
          <thead><tr><th style={S.th}>Grade</th><th style={S.th}>Min Score</th><th style={S.th}>Remark</th></tr></thead>
          <tbody>
            {rcForm.gradeScale.map(function(g,i){
              return(
                <tr key={g.grade}>
                  <td style={{...S.td,fontWeight:700}}>{g.grade}</td>
                  <td style={S.td}><input type="number" style={{...S.input,width:70}} value={g.min} onChange={function(e){var v=parseInt(e.target.value)||0;setRcForm(function(p){var gs=p.gradeScale.slice();gs[i]={...gs[i],min:v};return {...p,gradeScale:gs};});}}/></td>
                  <td style={S.td}><input style={S.input} value={g.remark} onChange={function(e){var v=e.target.value;setRcForm(function(p){var gs=p.gradeScale.slice();gs[i]={...gs[i],remark:v};return {...p,gradeScale:gs};});}}/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{...S.card,marginBottom:14}}>
        <div style={S.cardTitle}>Report Card Sections</div>
        {[["showAffectiveTraits","Affective Traits"],["showPsychomotorSkills","Psychomotor Skills"],["showPosition","Position (class &amp; subject)"],["showClassAverage","Class Average / Highest / Lowest / Weighted Score"],["showComments","Comment Blocks (Teacher / Form Master / Principal)"]].map(function(pair){
          return(
            <div key={pair[0]} style={{...S.row,justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid "+C.border}}>
              <span style={{fontSize:12}}>{pair[1]}</span>
              <button onClick={function(){setRcForm(function(p){return {...p,[pair[0]]:!p[pair[0]]};});}} style={{background:rcForm[pair[0]]?"#059669":"#E5E7EB",border:"none",borderRadius:12,width:44,height:24,position:"relative",cursor:"pointer"}}>
                <div style={{position:"absolute",top:3,left:rcForm[pair[0]]?23:3,width:18,height:18,background:"#fff",borderRadius:"50%",transition:"left 0.2s"}}/>
              </button>
            </div>
          );
        })}
      </div>

      <button style={S.btn()} onClick={function(){setSettingsSafe(function(p){return {...p,resultConfig:rcForm};});alert("Result sheet configuration saved.");}}>💾 Save Result Sheet Configuration</button>
    </div>}
  </div>);
}

// ══════════════════════════════════════════════════════
// LESSON NOTES MODULE (Teacher-facing)
// ══════════════════════════════════════════════════════
// Isolated from LessonsModule's table so typing in this form (and the AI
// auto-generate call, which sets several fields at once) never re-renders
// the lessons table below it.
function LessonFormModal({open, lesson, myStaff, staff, onSave, onClose}){
  const allSubjects=[...new Set([...SUBJECTS_JNR,...SUBJECTS_SNR])].sort();

  // Minimal input form — what the teacher actually fills before auto-generation
  const emptyForm = {
    teacherId:"", date:today(), class:"JSS1", arm:"A", subject:"",
    period:1, time:"8:00 AM - 9:00 AM",
    topic:"", subtopic:"", textbook:"", instructionalMaterials:"", previousKnowledge:"",
    keyPoints:"", // teacher's rough notes / keywords to guide the AI
    behaviouralObjectives:"",
    stepOne:{title:"Introduction / Set Induction",content:""},
    stepTwo:{title:"Presentation",content:""},
    stepThree:{title:"Activity / Practice",content:""},
    revision:"", evaluation:"", assignment:"",
    videoLinks:[], videoSearchSuggestions:[],
    status:"Draft", submissionOpen:true, generationStatus:"manual"
  };
  const [form, setForm] = useState(emptyForm);
  const [videoTitle, setVideoTitle] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  useEffect(function(){
    if(!open) return;
    if(lesson){
      setForm({...lesson,
        stepOne:{...(lesson.stepOne||{title:"Introduction / Set Induction",content:""})},
        stepTwo:{...(lesson.stepTwo||{title:"Presentation",content:""})},
        stepThree:{...(lesson.stepThree||{title:"Activity / Practice",content:""})},
        videoLinks:[...(lesson.videoLinks||[])],
        videoSearchSuggestions:[...(lesson.videoSearchSuggestions||[])],
        keyPoints:lesson.keyPoints||"",
        submissionOpen:lesson.submissionOpen!==false
      });
    } else {
      const f={...emptyForm};
      if(myStaff){f.teacherId=myStaff.id;f.subject=(myStaff.subjects||[])[0]||"";}
      setForm(f);
    }
    setGenError("");
    setVideoTitle("");setVideoUrl("");
  },[open,lesson,myStaff]);

  function handleSave(statusOverride){
    if(!form.topic||!form.class||!form.subject) return alert("Date, Class, Subject and Topic are required.");
    onSave(statusOverride?{...form,status:statusOverride}:form);
  }

  function addVideo(){
    if(!videoUrl) return;
    setForm(p=>({...p,videoLinks:[...(p.videoLinks||[]),{title:videoTitle||"Video",url:videoUrl}]}));
    setVideoTitle("");setVideoUrl("");
  }
  function removeVideo(idx){setForm(p=>({...p,videoLinks:p.videoLinks.filter((_,i)=>i!==idx)}));}

  // ─── AUTO-GENERATE LESSON CONTENT VIA CLAUDE API ───────────────
  async function generateLessonContent(){
    if(!form.topic||!form.class||!form.subject){
      setGenError("Please fill Class, Subject, and Topic before generating.");
      return;
    }
    setGenerating(true);
    setGenError("");
    try{
      const prompt = "You are an experienced Nigerian secondary school teacher writing a complete lesson note for the WAEC/NECO curriculum. " +
        "Generate a full lesson note in STRICT JSON format only (no markdown, no preamble, no code fences) with these exact keys: " +
        "subtopic, textbook, instructionalMaterials, previousKnowledge, behaviouralObjectives, stepOneTitle, stepOneContent, stepTwoTitle, stepTwoContent, stepThreeTitle, stepThreeContent, revision, evaluation, assignment, videoSearchQueries (an array of 2-3 short YouTube search query strings related to the topic, NOT urls). " +
        "Details: Class=" + form.class + " " + form.arm + ", Subject=" + form.subject + ", Topic=" + form.topic +
        (form.keyPoints ? (", Teacher's notes/keywords to guide content=" + form.keyPoints) : "") +
        ". Behavioural objectives should be 3 numbered measurable outcomes. Steps should be detailed classroom-ready paragraphs a teacher can read and follow directly. Evaluation should be 3-5 numbered questions. Assignment should be one clear, gradable task. Keep total content concise but complete and professional, suitable for Nigerian JSS/SS classroom use.";

      const response = await fetch("/api/ai", {
        method: "POST",
        headers: authFetchHeaders(),
        body: JSON.stringify({ prompt, max_tokens: 1500 })
      });
      const data = await response.json();
      if(data.error) throw new Error(data.error);
      if(!data.text) throw new Error("No content returned from AI.");
      let rawText = data.text.trim();
      // Try to parse as JSON first, otherwise use raw text as content
      let parsed;
      try{
        let cleaned = rawText.replace(/^```json\s*/,"").replace(/^```\s*/,"").replace(/\s*```$/,"").trim();
        parsed = JSON.parse(cleaned);
      } catch(e){
        // AI returned plain text - wrap it as content
        parsed = { content: rawText, objectives: "", materials: "", introduction: "", development: "", conclusion: "", evaluation: "", assignment: "" };
      }

      setForm(p => ({
        ...p,
        subtopic: parsed.subtopic || p.subtopic,
        textbook: parsed.textbook || p.textbook,
        instructionalMaterials: parsed.instructionalMaterials || p.instructionalMaterials,
        previousKnowledge: parsed.previousKnowledge || p.previousKnowledge,
        behaviouralObjectives: parsed.behaviouralObjectives || p.behaviouralObjectives,
        stepOne: { title: parsed.stepOneTitle || "Introduction / Set Induction", content: parsed.stepOneContent || "" },
        stepTwo: { title: parsed.stepTwoTitle || "Presentation", content: parsed.stepTwoContent || "" },
        stepThree: { title: parsed.stepThreeTitle || "Activity / Practice", content: parsed.stepThreeContent || "" },
        revision: parsed.revision || p.revision,
        evaluation: parsed.evaluation || p.evaluation,
        assignment: parsed.assignment || p.assignment,
        videoSearchSuggestions: Array.isArray(parsed.videoSearchQueries) ? parsed.videoSearchQueries : [],
        generationStatus: "ai-generated"
      }));
    } catch(err){
      console.error(err);
      setGenError("Generation failed. Please try again, or fill the fields manually. (" + (err.message||"unknown error") + ")");
    } finally {
      setGenerating(false);
    }
  }

  return(
    <Modal open={open} onClose={onClose} title={lesson?"Edit Lesson Note":"New Lesson Note"} extraWide>
      <div style={{maxHeight:"70vh",overflowY:"auto",paddingRight:8}}>
        <div style={{fontWeight:700,color:C.primary,marginBottom:10,fontSize:12,borderBottom:"2px solid "+C.primary,paddingBottom:6}}>📋 LESSON DETAILS</div>
        <div style={S.grid3}>
          <FormField form={form} setForm={setForm} label="Date *" field="date" type="date"/>
          <FormField form={form} setForm={setForm} label="Class *" field="class" opts={CLASSES}/>
          <FormField form={form} setForm={setForm} label="Arm" field="arm" opts={ARMS}/>
          <div style={S.formGroup}>
            <label style={S.label}>Teacher *</label>
            <select style={{...S.select,width:"100%"}} value={form.teacherId} onChange={e=>setForm(p=>({...p,teacherId:e.target.value}))}>
              <option value="">-- Select Teacher --</option>
              {staff.filter(s=>s.active).map(s=><option key={s.id} value={s.id}>{s.surname} {s.firstname}</option>)}
            </select>
          </div>
          <div style={S.formGroup}>
            <label style={S.label}>Subject *</label>
            <select style={{...S.select,width:"100%"}} value={form.subject} onChange={e=>setForm(p=>({...p,subject:e.target.value}))}>
              <option value="">-- Select --</option>
              {(form.teacherId?staff.find(s=>s.id===form.teacherId)?.subjects||allSubjects:allSubjects).map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
          <FormField form={form} setForm={setForm} label="Period" field="period" type="number"/>
          <FormField form={form} setForm={setForm} label="Time (e.g. 8:00 AM - 9:00 AM)" field="time"/>
          <div style={S.formGroup}>
            <label style={S.label}>Status</label>
            <select style={{...S.select,width:"100%"}} value={form.status} onChange={e=>setForm(p=>({...p,status:e.target.value}))}>
              <option>Draft</option><option>Published</option>
            </select>
          </div>
        </div>

        <FormField form={form} setForm={setForm} label="Topic *" field="topic"/>
        <FormField form={form} setForm={setForm} label="Teacher's Notes / Keywords (optional — guides the auto-generator, e.g. 'focus on photosynthesis stages, include diagram description')" field="keyPoints" type="textarea"/>

        {/* AUTO-GENERATE BUTTON */}
        <div style={{background:"linear-gradient(135deg,#EFF6FF,#F5F3FF)",border:"2px solid "+C.blue,borderRadius:10,padding:16,marginBottom:16,textAlign:"center"}}>
          <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:4}}>✨ Auto-Generate Lesson Content</div>
          <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>Fills Subtopic, Materials, Steps, Revision, Evaluation, Assignment and suggested video searches automatically based on the Topic and Keywords above.</div>
          <button style={{...S.btn("blue"),padding:"9px 22px",fontSize:12,opacity:generating?0.7:1}} onClick={generateLessonContent} disabled={generating}>
            {generating?"⏳ Generating... please wait":"⚡ Generate Lesson Content"}
          </button>
          {genError&&<div style={{color:C.danger,fontSize:11,marginTop:8}}>{genError}</div>}
          {form.generationStatus==="ai-generated"&&!generating&&<div style={{color:C.success,fontSize:11,marginTop:8,fontWeight:600}}>✓ Content generated — review and edit below before publishing</div>}
        </div>

        <div style={{fontWeight:700,color:C.primary,margin:"14px 0 10px",fontSize:12,borderBottom:"2px solid "+C.primary,paddingBottom:6}}>📚 LESSON CONTENT (review / edit)</div>
        <FormField form={form} setForm={setForm} label="Subtopic" field="subtopic"/>
        <div style={S.grid2}>
          <FormField form={form} setForm={setForm} label="Textbook" field="textbook"/>
          <FormField form={form} setForm={setForm} label="Instructional Materials" field="instructionalMaterials"/>
        </div>
        <FormField form={form} setForm={setForm} label="Previous Knowledge" field="previousKnowledge" type="textarea"/>
        <FormField form={form} setForm={setForm} label="Behavioural Objectives" field="behaviouralObjectives" type="textarea"/>

        <div style={{fontWeight:700,color:C.primary,margin:"14px 0 10px",fontSize:12,borderBottom:"2px solid "+C.primary,paddingBottom:6}}>🪜 LESSON STEPS</div>
        <div style={{background:"#F0FDF4",borderLeft:"3px solid "+C.success,borderRadius:"0 6px 6px 0",padding:"10px 12px",marginBottom:10}}>
          <FormField form={form} setForm={setForm} label="Step 1 Title" field="title" sub="stepOne"/>
          <FormField form={form} setForm={setForm} label="Step 1 Content" field="content" type="textarea" sub="stepOne"/>
        </div>
        <div style={{background:"#EFF6FF",borderLeft:"3px solid "+C.blue,borderRadius:"0 6px 6px 0",padding:"10px 12px",marginBottom:10}}>
          <FormField form={form} setForm={setForm} label="Step 2 Title" field="title" sub="stepTwo"/>
          <FormField form={form} setForm={setForm} label="Step 2 Content" field="content" type="textarea" sub="stepTwo"/>
        </div>
        <div style={{background:"#FFF7ED",borderLeft:"3px solid "+C.orange,borderRadius:"0 6px 6px 0",padding:"10px 12px",marginBottom:10}}>
          <FormField form={form} setForm={setForm} label="Step 3 Title" field="title" sub="stepThree"/>
          <FormField form={form} setForm={setForm} label="Step 3 Content" field="content" type="textarea" sub="stepThree"/>
        </div>

        <div style={{fontWeight:700,color:C.primary,margin:"14px 0 10px",fontSize:12,borderBottom:"2px solid "+C.primary,paddingBottom:6}}>📝 CLOSING</div>
        <FormField form={form} setForm={setForm} label="Revision" field="revision" type="textarea"/>
        <FormField form={form} setForm={setForm} label="Evaluation Questions" field="evaluation" type="textarea"/>
        <FormField form={form} setForm={setForm} label="Assignment" field="assignment" type="textarea"/>

        <div style={{fontWeight:700,color:C.primary,margin:"14px 0 10px",fontSize:12,borderBottom:"2px solid "+C.primary,paddingBottom:6}}>🎬 VIDEO RESOURCES</div>
        {(form.videoSearchSuggestions||[]).length>0&&(
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:C.textMuted,marginBottom:6}}>AI-suggested search terms — click to find a real video on YouTube, then paste its link below:</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {form.videoSearchSuggestions.map((q,i)=>(
                <a key={i} href={"https://www.youtube.com/results?search_query="+encodeURIComponent(q)} target="_blank" rel="noopener noreferrer"
                  style={{background:"#EFF6FF",border:"1px solid #93C5FD",borderRadius:6,padding:"5px 10px",fontSize:11,color:"#1D4ED8",fontWeight:600,textDecoration:"none"}}>
                  🔍 {q}
                </a>
              ))}
            </div>
          </div>
        )}
        <div style={S.row}>
          <input style={{...S.input,flex:1}} placeholder="Video title" value={videoTitle} onChange={e=>setVideoTitle(e.target.value)}/>
          <input style={{...S.input,flex:2}} placeholder="YouTube URL (e.g. https://youtube.com/watch?v=...)" value={videoUrl} onChange={e=>setVideoUrl(e.target.value)}/>
          <button style={S.btn()} onClick={addVideo}>+ Add</button>
        </div>
        {(form.videoLinks||[]).map((v,i)=>(
          <div key={i} style={{...S.row,marginTop:6,background:"#FEF2F2",padding:"5px 10px",borderRadius:6}}>
            <span style={{fontSize:11,flex:1}}>▶ {v.title} — {v.url.slice(0,40)}...</span>
            <button style={{...S.btn("danger"),fontSize:10,padding:"2px 6px"}} onClick={()=>removeVideo(i)}>Remove</button>
          </div>
        ))}

        <div style={{fontWeight:700,color:C.primary,margin:"14px 0 10px",fontSize:12,borderBottom:"2px solid "+C.primary,paddingBottom:6}}>🔓 ASSIGNMENT SUBMISSION CONTROL</div>
        <label style={{...S.row,fontSize:12,cursor:"pointer"}}>
          <input type="checkbox" checked={form.submissionOpen!==false} onChange={e=>setForm(p=>({...p,submissionOpen:e.target.checked}))}/>
          Allow students to submit this assignment (uncheck to close submissions at any time)
        </label>
      </div>
      <div style={{...S.row,justifyContent:"flex-end",marginTop:16,gap:8,borderTop:"1px solid "+C.border,paddingTop:14}}>
        <button style={S.btn("secondary")} onClick={onClose}>Cancel</button>
        <button style={{...S.btn("secondary")}} onClick={()=>handleSave("Draft")}>Save as Draft</button>
        <button style={S.btn()} onClick={()=>handleSave("Published")}>Publish to Students</button>
      </div>
    </Modal>
  );
}

function LessonsModule({staff, students, lessons, setLessons, assignments, setAssignments, currentUser}){
  const [tab, setTab] = useState("list");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editingLesson, setEditingLesson] = useState(null);
  const [viewLesson, setViewLesson] = useState(null);
  const [filterCls, setFilterCls] = useState("");
  const [filterSub, setFilterSub] = useState("");
  const lessonViewRef = useRef();

  const isAdmin = currentUser.role==="root"||currentUser.role==="Admin";
  const myStaff = staff.find(s=>s.id===currentUser.staffId||
    (s.surname+" "+s.firstname).toLowerCase()===currentUser.name.toLowerCase());
  const allSubjects=[...new Set([...SUBJECTS_JNR,...SUBJECTS_SNR])].sort();

  const filtered = lessons.filter(l=>
    (!filterCls||l.class===filterCls) &&
    (!filterSub||l.subject===filterSub) &&
    (isAdmin || l.teacherId===(myStaff?.id||currentUser.staffId))
  );

  function openAdd(){
    setEditingLesson(null);setEditing(null);setShowForm(true);
  }
  function openEdit(l){
    setEditingLesson(l);setEditing(l.id);setShowForm(true);
  }

  function handleFormSave(toSave){
    if(editing){setLessons(p=>p.map(l=>l.id===editing?{...toSave,id:editing}:l));}
    else{setLessons(p=>[...p,{...toSave,id:genId(),createdAt:today()}]);}
    setShowForm(false);
  }

  function createAssignment(lesson){
    const existing = assignments.find(a=>a.lessonId===lesson.id);
    if(existing){alert("Assignment already created for this lesson.");return;}
    if(!lesson.assignment){alert("No assignment text in this lesson note.");return;}
    setAssignments(p=>[...p,{
      id:genId(),lessonId:lesson.id,teacherId:lesson.teacherId,
      class:lesson.class,subject:lesson.subject,
      title:lesson.topic+" — Assignment",
      description:lesson.assignment,
      dueDate:"",maxScore:20,status:"Active",createdAt:today()
    }]);
    alert("Assignment created! Students in "+lesson.class+" can now see and submit it (while submissions remain open).");
  }

  function toggleSubmission(lesson){
    const newVal = lesson.submissionOpen===false ? true : false;
    setLessons(p=>p.map(l=>l.id===lesson.id?{...l,submissionOpen:newVal}:l));
    // Also reflect on the linked assignment's status
    setAssignments(p=>p.map(a=>a.lessonId===lesson.id?{...a,status:newVal?"Active":"Closed"}:a));
  }

  function getTeacherName(id){
    const t=staff.find(s=>s.id===id);
    return t?t.surname+" "+t.firstname:"—";
  }

  return(<div>
    <div style={{...S.row,marginBottom:12,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
      <div style={S.row}>
        <select style={S.select} value={filterCls} onChange={e=>setFilterCls(e.target.value)}>
          <option value="">All Classes</option>{CLASSES.map(c=><option key={c}>{c}</option>)}
        </select>
        <select style={S.select} value={filterSub} onChange={e=>setFilterSub(e.target.value)}>
          <option value="">All Subjects</option>{allSubjects.map(s=><option key={s}>{s}</option>)}
        </select>
      </div>
      <button style={S.btn()} onClick={openAdd}><span style={S.row}><Icon name="plus" size={13}/>New Lesson Note</span></button>
    </div>

    <div style={S.card}>
      <table style={S.table}>
        <thead><tr>{["Date","Class","Subject","Topic","Teacher","Status","Submissions","Actions"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
        <tbody>
          {filtered.length===0&&<tr><td colSpan={8} style={{...S.td,textAlign:"center",color:C.textMuted,padding:28}}>No lesson notes yet.</td></tr>}
          {filtered.map(l=>{
            const hasAssignment=assignments.some(a=>a.lessonId===l.id);
            const submissionOpen = l.submissionOpen!==false;
            return(<tr key={l.id}>
              <td style={S.td}>{formatDate(l.date)}</td>
              <td style={S.td}>{l.class}{l.arm}</td>
              <td style={S.td}>{l.subject}</td>
              <td style={{...S.td,fontWeight:600}}>{l.topic}{l.generationStatus==="ai-generated"&&<span style={{...S.badge("blue"),marginLeft:6,fontSize:9}}>✨ AI</span>}</td>
              <td style={S.td}>{getTeacherName(l.teacherId)}</td>
              <td style={S.td}><span style={S.badge(l.status==="Published"?"green":"yellow")}>{l.status}</span></td>
              <td style={S.td}>{hasAssignment?<span style={S.badge(submissionOpen?"green":"red")}>{submissionOpen?"🟢 Open":"🔒 Closed"}</span>:<span style={{fontSize:10,color:C.textMuted}}>—</span>}</td>
              <td style={S.td}>
                <div style={S.row}>
                  <button style={{...S.btn("primary"),fontSize:10,padding:"3px 7px"}} onClick={()=>setViewLesson(l)}>View</button>
                  <button style={{...S.btn("secondary"),fontSize:10,padding:"3px 7px"}} onClick={()=>openEdit(l)}>Edit</button>
                  {!hasAssignment&&l.assignment&&<button style={{...S.btn("gold"),fontSize:10,padding:"3px 7px"}} onClick={()=>createAssignment(l)}>📝 Create Assignment</button>}
                  {hasAssignment&&<button style={{...S.btn(submissionOpen?"danger":"success"),fontSize:10,padding:"3px 7px"}} onClick={()=>toggleSubmission(l)}>{submissionOpen?"🔒 Close Submissions":"🟢 Open Submissions"}</button>}
                  <button style={{...S.btn("danger"),fontSize:10,padding:"3px 7px"}} onClick={()=>{if(window.confirm("Delete?"))setLessons(p=>p.filter(x=>x.id!==l.id));}}>Del</button>
                </div>
              </td>
            </tr>);
          })}
        </tbody>
      </table>
    </div>

    {/* View Lesson Modal */}
    <Modal open={!!viewLesson} onClose={()=>setViewLesson(null)} title="Lesson Note" extraWide>
      {viewLesson&&<div ref={lessonViewRef}>
        <div style={{background:C.primaryDark,borderRadius:8,padding:"14px 18px",marginBottom:16,color:C.white}}>
          <div style={{...S.row,gap:12}}>
            <SchoolLogoImg size={44}/>
            <div>
              <div style={{fontSize:15,fontWeight:800,color:C.goldLight}}>{SCHOOL_NAME}</div>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.6)"}}>{SCHOOL_ADDRESS}</div>
            </div>
          </div>
          <div style={{marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
            {[["Date",formatDate(viewLesson.date)],["Class",viewLesson.class+viewLesson.arm],["Subject",viewLesson.subject],["Period","P"+viewLesson.period],["Time",viewLesson.time],["Teacher",getTeacherName(viewLesson.teacherId)]].map(([k,v])=>(
              <div key={k}><div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontWeight:600}}>{k}</div><div style={{fontSize:12,color:C.goldLight,fontWeight:600}}>{v}</div></div>
            ))}
          </div>
        </div>

        {[
          {label:"TOPIC",val:viewLesson.topic,bold:true},
          {label:"SUBTOPIC",val:viewLesson.subtopic},
          {label:"TEXTBOOK",val:viewLesson.textbook},
          {label:"INSTRUCTIONAL MATERIALS",val:viewLesson.instructionalMaterials},
          {label:"PREVIOUS KNOWLEDGE",val:viewLesson.previousKnowledge},
          {label:"BEHAVIOURAL OBJECTIVES",val:viewLesson.behaviouralObjectives},
        ].map(({label,val,bold})=>val?(
          <div key={label} style={{marginBottom:10,paddingBottom:8,borderBottom:"1px solid "+C.border}}>
            <div style={{fontSize:10,fontWeight:700,color:C.primary,letterSpacing:"0.06em",marginBottom:3}}>{label}</div>
            <div style={{fontSize:12,color:C.text,fontWeight:bold?600:400,lineHeight:1.6}}>{val}</div>
          </div>
        ):null)}

        {[viewLesson.stepOne,viewLesson.stepTwo,viewLesson.stepThree].map((step,i)=>step?.content?(
          <div key={i} style={{marginBottom:12,background:"#F0FDF4",borderLeft:"3px solid "+C.success,borderRadius:"0 6px 6px 0",padding:"10px 14px"}}>
            <div style={{fontSize:11,fontWeight:700,color:C.success,marginBottom:4}}>STEP {i+1}: {step.title?.toUpperCase()}</div>
            <div style={{fontSize:12,color:C.text,lineHeight:1.6}}>{step.content}</div>
          </div>
        ):null)}

        {[["REVISION",viewLesson.revision],["EVALUATION",viewLesson.evaluation],["ASSIGNMENT",viewLesson.assignment]].map(([label,val])=>val?(
          <div key={label} style={{marginBottom:10,paddingBottom:8,borderBottom:"1px solid "+C.border}}>
            <div style={{fontSize:10,fontWeight:700,color:C.primary,letterSpacing:"0.06em",marginBottom:3}}>{label}</div>
            <div style={{fontSize:12,color:C.text,lineHeight:1.6,whiteSpace:"pre-line"}}>{val}</div>
          </div>
        ):null)}

        {(viewLesson.videoLinks||[]).length>0&&(
          <div style={{marginTop:12}}>
            <div style={{fontSize:10,fontWeight:700,color:C.primary,letterSpacing:"0.06em",marginBottom:8}}>VIDEO RESOURCES</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {viewLesson.videoLinks.map((v,i)=>(
                <a key={i} href={v.url} target="_blank" rel="noopener noreferrer"
                  style={{background:"#FEE2E2",border:"1px solid #FCA5A5",borderRadius:6,padding:"8px 12px",fontSize:11,color:"#DC2626",fontWeight:600,textDecoration:"none",...S.row,gap:6}}>
                  ▶ {v.title}
                </a>
              ))}
            </div>
          </div>
        )}

        {(viewLesson.videoSearchSuggestions||[]).length>0&&(
          <div style={{marginTop:12}}>
            <div style={{fontSize:10,fontWeight:700,color:C.primary,letterSpacing:"0.06em",marginBottom:8}}>SUGGESTED YOUTUBE SEARCHES (AI-generated — pick and verify a real video)</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {viewLesson.videoSearchSuggestions.map((q,i)=>(
                <a key={i} href={"https://www.youtube.com/results?search_query="+encodeURIComponent(q)} target="_blank" rel="noopener noreferrer"
                  style={{background:"#EFF6FF",border:"1px solid #93C5FD",borderRadius:6,padding:"7px 11px",fontSize:11,color:"#1D4ED8",fontWeight:600,textDecoration:"none"}}>
                  🔍 {q}
                </a>
              ))}
            </div>
          </div>
        )}

        <div style={{...S.row,justifyContent:"flex-end",marginTop:16,gap:8,flexWrap:"wrap"}}>
          <button style={{...S.btn("secondary"),fontSize:11}} onClick={()=>window.print()}>🖨 Print</button>
          <button style={{...S.btn("blue"),fontSize:11}} onClick={()=>downloadNodeAsPDF(lessonViewRef.current, viewLesson.topic+"_LessonNote").catch(e=>alert("Could not generate PDF: "+e.message))}>⬇ PDF</button>
          <button style={{...S.btn("gold"),fontSize:11}} onClick={()=>shareNode(lessonViewRef.current, viewLesson.topic+"_LessonNote", "Lesson Note — "+viewLesson.topic).catch(e=>alert("Could not share: "+e.message))}>📤 Share</button>
          <button style={S.btn()} onClick={()=>setViewLesson(null)}>Close</button>
        </div>
      </div>}
    </Modal>

    <LessonFormModal open={showForm} lesson={editingLesson} myStaff={myStaff} staff={staff} onSave={handleFormSave} onClose={()=>setShowForm(false)}/>
  </div>);
}

function StudentPortalModule({students, staff, lessons, assignments, submissions, setSubmissions, results, setResults, currentUser}){
  const [tab, setTab] = useState("lessons");

  const isTeacherOrAdmin = currentUser.role==="root"||currentUser.role==="Admin"||currentUser.role==="Teacher";
  const myStaff = staff.find(s=>(s.surname+" "+s.firstname).toLowerCase()===currentUser.name.toLowerCase());
  const myStudent = students.find(s=>(s.surname+" "+s.firstname).toLowerCase()===currentUser.name.toLowerCase());

  const accessibleClasses = isTeacherOrAdmin
    ? (currentUser.role==="root"||currentUser.role==="Admin"?CLASSES:(myStaff?.classes||CLASSES))
    : (myStudent?[myStudent.class]:[]);

  const [selCls, setSelCls] = useState(accessibleClasses[0]||"JSS1");
  const [selLesson, setSelLesson] = useState(null);
  const [selAssignment, setSelAssignment] = useState(null);
  const [submissionText, setSubmissionText] = useState("");
  const [markingAssignment, setMarkingAssignment] = useState(null);

  // Only published lessons are ever visible to students.
  const classLessons = lessons.filter(l=>l.class===selCls&&l.status==="Published");
  // Teachers/admins see every class assignment (for marking/oversight); a student
  // viewer only sees ones with no explicit targeting, or ones targeted to them
  // specifically (see the "assign remedial work" tool in Results → Score Entry).
  const classAssignments = assignments.filter(a=>a.class===selCls && (isTeacherOrAdmin || !a.targetStudentIds || a.targetStudentIds.length===0 || (myStudent&&a.targetStudentIds.includes(myStudent.id))));

  function mySubmission(assignmentId){
    return myStudent?submissions.find(s=>s.assignmentId===assignmentId&&s.studentId===myStudent.id):null;
  }

  function isSubmissionOpen(asn){
    const lesson = lessons.find(l=>l.id===asn.lessonId);
    if(lesson) return lesson.submissionOpen!==false;
    return asn.status!=="Closed";
  }

  function submitAssignment(){
    if(!submissionText.trim()) return alert("Please write your answer before submitting.");
    if(!myStudent) return alert("Student account not found.");
    if(!isSubmissionOpen(selAssignment)) return alert("Submissions for this assignment are currently closed by the teacher.");
    const existing = mySubmission(selAssignment.id);
    if(existing) return alert("You have already submitted this assignment.");
    setSubmissions(p=>[...p,{
      id:genId(),assignmentId:selAssignment.id,studentId:myStudent.id,
      submittedAt:today(),content:submissionText,
      score:null,feedback:"",marked:false
    }]);
    setSubmissionText("");
    setSelAssignment(null);
    alert("Assignment submitted successfully!");
  }

  const [markScore, setMarkScore] = useState("");
  const [markFeedback, setMarkFeedback] = useState("");

  function openMarking(asn){
    setMarkingAssignment(asn);setMarkScore("");setMarkFeedback("");
  }

  function saveMark(sub){
    const sc = parseInt(markScore);
    if(isNaN(sc)||sc<0||sc>markingAssignment.maxScore) return alert("Enter a valid score (0 - "+markingAssignment.maxScore+")");
    setSubmissions(p=>p.map(s=>s.id===sub.id?{...s,score:sc,feedback:markFeedback,marked:true}:s));
    const stu = students.find(s=>s.id===sub.studentId);
    if(stu){
      const asn = markingAssignment;
      setResults(prev=>{
        const existing = prev.find(r=>r.studentId===sub.studentId&&r.session===CURRENT_SESSION&&r.term===CURRENT_TERM&&r.subject===asn.subject&&r.type==="assignment"&&r.lessonId===asn.lessonId);
        if(existing) return prev.map(r=>r.id===existing.id?{...r,assignmentScore:sc}:r);
        return [...prev,{
          id:genId(),studentId:sub.studentId,session:CURRENT_SESSION,term:CURRENT_TERM,
          class:stu.class,subject:asn.subject,type:"assignment",
          lessonId:asn.lessonId,assignmentId:asn.id,
          assignmentScore:sc,maxScore:asn.maxScore,createdAt:today()
        }];
      });
    }
    setMarkingAssignment(null);
    alert("Marked! Score of "+sc+"/"+markingAssignment.maxScore+" saved to student record.");
  }

  function getSubmissions(assignmentId){
    return submissions.filter(s=>s.assignmentId===assignmentId);
  }

  function getStudentAssignmentScores(studentId){
    return results.filter(r=>r.studentId===studentId&&r.type==="assignment"&&r.session===CURRENT_SESSION&&r.term===CURRENT_TERM);
  }

  // Students in selCls who have NOT submitted a given assignment — flagged for teacher
  function getNonSubmitters(asn){
    const classStudents = students.filter(s=>s.active&&s.class===asn.class);
    const submittedIds = getSubmissions(asn.id).map(s=>s.studentId);
    return classStudents.filter(s=>!submittedIds.includes(s.id));
  }

  function getYouTubeEmbed(url){
    if(!url) return null;
    const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match?"https://www.youtube.com/embed/"+match[1]:null;
  }

  return(<div>
    <div style={{...S.card,marginBottom:14}}>
      <div style={S.row}>
        <label style={{...S.label,marginBottom:0,marginRight:6}}>Class:</label>
        {accessibleClasses.map(cls=>(
          <button key={cls} style={{...S.btn(selCls===cls?"primary":"secondary"),fontSize:11}} onClick={()=>setSelCls(cls)}>{cls}</button>
        ))}
        {accessibleClasses.length===0&&<span style={{fontSize:12,color:C.danger}}>No class access — contact admin.</span>}
        {isTeacherOrAdmin&&<span style={{...S.badge("blue"),marginLeft:8,fontSize:10}}>Teacher/Admin View</span>}
        {myStudent&&<span style={{...S.badge("green"),marginLeft:8,fontSize:10}}>Student: {myStudent.surname} {myStudent.firstname} ({myStudent.class}{myStudent.arm})</span>}
      </div>
    </div>

    <div style={{...S.row,marginBottom:14,gap:4,borderBottom:"2px solid "+C.border,paddingBottom:0}}>
      <button style={{...S.btn(tab==="lessons"?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11}} onClick={()=>setTab("lessons")}>📖 Lesson Notes</button>
      <button style={{...S.btn(tab==="assignments"?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11}} onClick={()=>setTab("assignments")}>📝 Assignments</button>
      {isTeacherOrAdmin&&<button style={{...S.btn(tab==="marking"?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11}} onClick={()=>setTab("marking")}>✅ Marking</button>}
      {myStudent&&<button style={{...S.btn(tab==="myscores"?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11}} onClick={()=>setTab("myscores")}>🏆 My Scores</button>}
    </div>

    {/* ── LESSON NOTES TAB — Students only ever see explanation + video + assignment ── */}
    {tab==="lessons"&&<div>
      {selLesson?(
        <div style={S.card}>
          <button style={{...S.btn("secondary"),fontSize:11,marginBottom:14}} onClick={function(){setSelLesson(null);}}>← Back to Lessons</button>
          <div style={{background:C.primaryDark,borderRadius:8,padding:"14px 18px",marginBottom:16,color:"#fff"}}>
            <div style={{fontSize:15,fontWeight:800,color:"#F0C060"}}>{selLesson.topic}</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:4}}>{selLesson.subject} · {selLesson.class}{selLesson.arm} · {formatDate(selLesson.date)}</div>
          </div>

          {isTeacherOrAdmin ? (
            <div>
              {/* Teachers see full note */}
              {selLesson.subtopic&&<div style={{fontSize:13,fontStyle:"italic",color:C.textMuted,marginBottom:12}}>{selLesson.subtopic}</div>}
              {selLesson.behaviouralObjectives&&<div style={{marginBottom:12,background:"#F0FDF4",borderRadius:8,padding:"10px 14px"}}><div style={{fontSize:11,fontWeight:700,color:C.success,marginBottom:4}}>BEHAVIOURAL OBJECTIVES</div><div style={{fontSize:13,lineHeight:1.7,whiteSpace:"pre-line"}}>{selLesson.behaviouralObjectives}</div></div>}
              {[selLesson.stepOne,selLesson.stepTwo,selLesson.stepThree].map(function(step,i){return step&&step.content?(<div key={i} style={{marginBottom:12,background:i===0?"#F0FDF4":i===1?"#EFF6FF":"#FFF7ED",borderLeft:"3px solid "+(i===0?C.success:i===1?C.blue:"#D97706"),borderRadius:8,padding:"10px 14px"}}><div style={{fontSize:11,fontWeight:700,color:i===0?C.success:i===1?C.blue:"#D97706",marginBottom:6}}>{step.title}</div><div style={{fontSize:13,lineHeight:1.7}}>{step.content}</div></div>):null;})}
              {selLesson.revision&&<div style={{marginBottom:10,background:"#F9FAFB",borderRadius:8,padding:"10px 14px"}}><div style={{fontSize:11,fontWeight:700,marginBottom:4}}>REVISION</div><div style={{fontSize:13,lineHeight:1.7}}>{selLesson.revision}</div></div>}
              {selLesson.evaluation&&<div style={{marginBottom:14,background:"#F9FAFB",borderRadius:8,padding:"10px 14px"}}><div style={{fontSize:11,fontWeight:700,marginBottom:4}}>EVALUATION</div><div style={{fontSize:13,lineHeight:1.7}}>{selLesson.evaluation}</div></div>}
            </div>
          ) : (
            <div>
              {/* Students see ONLY: topic summary, keywords, objectives, video, assignment */}
              {selLesson.subtopic&&<div style={{...S.card,background:"#EFF6FF",marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:C.primary,marginBottom:4}}>📌 SUBTOPIC</div><div style={{fontSize:13}}>{selLesson.subtopic}</div></div>}
              {selLesson.behaviouralObjectives&&<div style={{...S.card,background:"#F0FDF4",marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:C.success,marginBottom:6}}>🎯 LEARNING OBJECTIVES</div><div style={{fontSize:13,lineHeight:1.8,whiteSpace:"pre-line"}}>{selLesson.behaviouralObjectives}</div></div>}
              {selLesson.keyPoints&&<div style={{...S.card,background:"#FFF7ED",marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:"#D97706",marginBottom:6}}>🔑 KEY POINTS / KEYWORDS</div><div style={{fontSize:13,lineHeight:1.8,whiteSpace:"pre-line"}}>{selLesson.keyPoints}</div></div>}
              {selLesson.previousKnowledge&&<div style={{...S.card,marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:C.textMuted,marginBottom:4}}>📚 PRIOR KNOWLEDGE NEEDED</div><div style={{fontSize:13}}>{selLesson.previousKnowledge}</div></div>}
            </div>
          )}

          {/* Video — visible to all */}
          {(selLesson.videoLinks||[]).length>0&&(
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:C.primary,marginBottom:10}}>🎬 VIDEO RESOURCES</div>
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                {selLesson.videoLinks.map(function(v,i){
                  var embed = v.url&&v.url.includes("youtube")?v.url.replace("watch?v=","embed/").replace("youtu.be/","www.youtube.com/embed/"):null;
                  return(
                    <div key={i} style={{borderRadius:8,overflow:"hidden",border:"2px solid "+C.border}}>
                      <div style={{background:C.primaryDark,padding:"8px 12px",color:"#F0C060",fontWeight:600,fontSize:12}}>▶ {v.title}</div>
                      {embed?(<iframe width="100%" height="240" src={embed} title={v.title} frameBorder="0" allowFullScreen style={{display:"block"}}/>):(<a href={v.url} target="_blank" rel="noopener noreferrer" style={{display:"block",padding:"12px",background:"#FEE2E2",color:C.danger,fontWeight:600,fontSize:12}}>🔗 Open Video Link: {v.url}</a>)}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Assignment — visible to all */}
          {selLesson.assignment&&<div style={{background:"#FFFBEB",border:"1px solid #F59E0B",borderRadius:8,padding:"12px 16px",marginBottom:14}}><div style={{fontSize:10,fontWeight:700,color:"#D97706",marginBottom:4}}>📝 ASSIGNMENT</div><div style={{fontSize:13,lineHeight:1.6}}>{selLesson.assignment}</div>{!isTeacherOrAdmin&&<div style={{fontSize:11,color:C.textMuted,marginTop:6}}>Go to the Assignments tab to submit your answer.</div>}</div>}
        </div>
      ):(
        <div>
          {classLessons.length===0&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No published lessons for {selCls} yet.</div>}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
            {classLessons.map(l=>{
              const hasVideo=(l.videoLinks||[]).length>0;
              return(
                <div key={l.id} onClick={()=>setSelLesson(l)} style={{...S.card,cursor:"pointer",borderLeft:"4px solid "+C.primary,marginBottom:0}}
                  onMouseEnter={e=>e.currentTarget.style.background="#F0FDF4"}
                  onMouseLeave={e=>e.currentTarget.style.background=C.white}>
                  <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:4}}>{l.topic}</div>
                  <div style={{fontSize:11,color:C.textMuted,marginBottom:6}}>{l.subject} · {formatDate(l.date)}</div>
                  {l.subtopic&&<div style={{fontSize:11,color:C.textMuted,fontStyle:"italic",marginBottom:6}}>{l.subtopic}</div>}
                  <div style={S.row}>
                    {hasVideo&&<span style={S.badge("red")}>▶ {l.videoLinks.length} Video{l.videoLinks.length>1?"s":""}</span>}
                    {l.assignment&&<span style={S.badge("yellow")}>📝 Has Assignment</span>}
                    <span style={{...S.badge("green"),marginLeft:"auto"}}>Open →</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>}

    {/* ── ASSIGNMENTS TAB ── */}
    {tab==="assignments"&&<div>
      {classAssignments.length===0&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No assignments for {selCls}.</div>}
      {classAssignments.map(asn=>{
        const sub=myStudent?mySubmission(asn.id):null;
        const allSubs=getSubmissions(asn.id);
        const open=isSubmissionOpen(asn);
        return(
          <div key={asn.id} style={S.card}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
              <div style={{flex:1}}>
                <div style={{...S.row}}>
                  <div style={{fontSize:14,fontWeight:700,color:C.primaryDark}}>{asn.title}</div>
                  <span style={S.badge(open?"green":"red")}>{open?"🟢 Submissions Open":"🔒 Submissions Closed"}</span>
                </div>
                <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{asn.subject} · Due: {asn.dueDate?formatDate(asn.dueDate):"Open"} · Max: {asn.maxScore} marks</div>
                <div style={{fontSize:12,color:C.text,marginTop:8,lineHeight:1.6}}>{asn.description}</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                {isTeacherOrAdmin&&<span style={S.badge("blue")}>{allSubs.length} submission{allSubs.length!==1?"s":""}</span>}
                {sub&&<div style={{marginTop:4}}><span style={S.badge(sub.marked?"green":"yellow")}>{sub.marked?"Marked":"Submitted"}</span>{sub.marked&&<div style={{fontWeight:700,fontSize:13,color:C.success,marginTop:4}}>{sub.score}/{asn.maxScore}</div>}</div>}
              </div>
            </div>

            {myStudent&&!sub&&open&&selAssignment?.id!==asn.id&&(
              <button style={{...S.btn(),marginTop:12,fontSize:11}} onClick={()=>setSelAssignment(asn)}>📝 Submit Assignment</button>
            )}
            {myStudent&&!sub&&!open&&(
              <div style={{marginTop:12,background:C.dangerLight,border:"1px solid "+C.danger,borderRadius:8,padding:10,fontSize:12,color:C.danger,fontWeight:600}}>
                🔒 Submissions for this assignment have been closed by your teacher. You missed the deadline.
              </div>
            )}
            {myStudent&&!sub&&open&&selAssignment?.id===asn.id&&(
              <div style={{marginTop:12,background:C.ivory,border:"1px solid "+C.border,borderRadius:8,padding:14}}>
                <label style={{...S.label,marginBottom:6}}>Your Answer:</label>
                <textarea style={{...S.textarea,minHeight:120}} value={submissionText} onChange={e=>setSubmissionText(e.target.value)} placeholder="Type your answer here..."/>
                <div style={{...S.row,marginTop:10,gap:8}}>
                  <button style={S.btn()} onClick={submitAssignment}>Submit</button>
                  <button style={S.btn("secondary")} onClick={()=>{setSelAssignment(null);setSubmissionText("");}}>Cancel</button>
                </div>
              </div>
            )}

            {sub&&(
              <div style={{marginTop:12,background:sub.marked?C.successLight:C.warningLight,border:"1px solid "+(sub.marked?C.success:C.gold),borderRadius:8,padding:12}}>
                <div style={{fontSize:11,fontWeight:700,color:sub.marked?C.success:C.warning,marginBottom:6}}>
                  {sub.marked?"✓ Marked":"⏳ Submitted — Awaiting Marking"}
                </div>
                <div style={{fontSize:12,color:C.text,lineHeight:1.6,marginBottom:sub.marked?8:0}}>{sub.content}</div>
                {sub.marked&&<>
                  <div style={{fontWeight:700,fontSize:14,color:C.success}}>Score: {sub.score}/{asn.maxScore}</div>
                  {sub.feedback&&<div style={{fontSize:12,color:C.primaryDark,marginTop:6,fontStyle:"italic"}}>Teacher's comment: "{sub.feedback}"</div>}
                </>}
              </div>
            )}
          </div>
        );
      })}
    </div>}

    {/* ── MARKING TAB (teacher only) — includes non-submitter flags ── */}
    {tab==="marking"&&isTeacherOrAdmin&&<div>
      {classAssignments.length===0&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No assignments set for {selCls}.</div>}
      {classAssignments.map(asn=>{
        const subs=getSubmissions(asn.id);
        const marked=subs.filter(s=>s.marked).length;
        const nonSubmitters=getNonSubmitters(asn);
        const open=isSubmissionOpen(asn);
        return(
          <div key={asn.id} style={S.card}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div>
                <div style={{...S.row}}>
                  <div style={{fontSize:13,fontWeight:700,color:C.primaryDark}}>{asn.title}</div>
                  <span style={S.badge(open?"green":"red")}>{open?"🟢 Open":"🔒 Closed"}</span>
                </div>
                <div style={{fontSize:11,color:C.textMuted}}>{asn.subject} · Max: {asn.maxScore} marks · {subs.length} submissions · {marked} marked</div>
              </div>
              <div style={S.row}>
                <MiniBar value={marked} max={subs.length||1} color={C.success} height={8}/>
                <span style={{fontSize:10,fontWeight:600,minWidth:50}}>{subs.length?Math.round((marked/subs.length)*100):0}% marked</span>
              </div>
            </div>

            {/* NON-SUBMITTER FLAGS */}
            {nonSubmitters.length>0&&(
              <div style={{background:C.dangerLight,border:"1px solid "+C.danger,borderRadius:8,padding:12,marginBottom:12}}>
                <div style={{fontSize:11,fontWeight:700,color:C.danger,marginBottom:8}}>🚩 {nonSubmitters.length} Student(s) Have NOT Submitted</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {nonSubmitters.map(s=>(
                    <span key={s.id} style={{background:C.white,border:"1px solid "+C.danger,borderRadius:6,padding:"4px 10px",fontSize:11,fontWeight:600,color:C.danger}}>
                      {s.surname} {s.firstname}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {subs.length===0&&<div style={{fontSize:12,color:C.textMuted,textAlign:"center",padding:12}}>No submissions yet for this assignment.</div>}
            {subs.map(sub=>{
              const stu=students.find(s=>s.id===sub.studentId);
              return(
                <div key={sub.id} style={{background:sub.marked?C.successLight:C.ivory,border:"1px solid "+(sub.marked?C.success:C.border),borderRadius:8,padding:12,marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{fontSize:12,fontWeight:700}}>{stu?stu.surname+" "+stu.firstname:"Unknown"} <span style={{fontWeight:400,color:C.textMuted}}>({stu?stu.admissionNo:"—"})</span></div>
                      <div style={{fontSize:10,color:C.textMuted}}>Submitted: {formatDate(sub.submittedAt)}</div>
                    </div>
                    {sub.marked?(
                      <div style={{textAlign:"right"}}>
                        <span style={S.badge("green")}>✓ Marked</span>
                        <div style={{fontWeight:700,color:C.success,fontSize:13,marginTop:2}}>{sub.score}/{asn.maxScore}</div>
                        {sub.feedback&&<div style={{fontSize:10,color:C.textMuted,fontStyle:"italic"}}>"{sub.feedback}"</div>}
                      </div>
                    ):(
                      <button style={{...S.btn("gold"),fontSize:11}} onClick={()=>{openMarking(asn);setMarkingAssignment({...asn,_sub:sub});}}>✏ Mark</button>
                    )}
                  </div>
                  <div style={{fontSize:12,color:C.text,marginTop:8,background:C.white,padding:"8px 10px",borderRadius:6,lineHeight:1.6,borderLeft:"3px solid "+C.primary}}>{sub.content}</div>

                  {markingAssignment?.id===asn.id&&markingAssignment?._sub?.id===sub.id&&(
                    <div style={{marginTop:10,background:"#FFFBEB",border:"1px solid "+C.gold,borderRadius:6,padding:12}}>
                      <div style={{fontSize:11,fontWeight:700,color:C.warning,marginBottom:8}}>Mark This Submission</div>
                      <div style={S.grid2}>
                        <div style={S.formGroup}>
                          <label style={S.label}>Score (out of {asn.maxScore})</label>
                          <input style={S.input} type="number" min="0" max={asn.maxScore} value={markScore} onChange={e=>setMarkScore(e.target.value)} placeholder="Enter score"/>
                        </div>
                        <div style={S.formGroup}>
                          <label style={S.label}>Teacher's Feedback (optional)</label>
                          <input style={S.input} value={markFeedback} onChange={e=>setMarkFeedback(e.target.value)} placeholder="e.g. Good work! Improve on..."/>
                        </div>
                      </div>
                      <div style={S.row}>
                        <button style={S.btn()} onClick={()=>saveMark(sub)}>Save Mark & Link to Record</button>
                        <button style={S.btn("secondary")} onClick={()=>setMarkingAssignment(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>}

    {/* ── MY SCORES TAB (student only) ── */}
    {tab==="myscores"&&myStudent&&<div>
      <div style={S.card}>
        <div style={S.cardTitle}>My Assignment Scores — {CURRENT_TERM} {CURRENT_SESSION}</div>
        {getStudentAssignmentScores(myStudent.id).length===0?(
          <div style={{textAlign:"center",color:C.textMuted,padding:28}}>No marked assignments yet this term.</div>
        ):(
          <table style={S.table}>
            <thead><tr>{["Subject","Assignment","Score","Out of","Percentage","Feedback"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {getStudentAssignmentScores(myStudent.id).map((r,i)=>{
                const asn=assignments.find(a=>a.id===r.assignmentId);
                const sub=submissions.find(s=>s.assignmentId===r.assignmentId&&s.studentId===myStudent.id);
                const pct=r.maxScore?Math.round((r.assignmentScore/r.maxScore)*100):0;
                return(
                  <tr key={i} style={{background:pct>=70?C.successLight:pct>=50?C.warningLight:C.dangerLight}}>
                    <td style={{...S.td,fontWeight:600}}>{r.subject}</td>
                    <td style={S.td}>{asn?.title||"—"}</td>
                    <td style={{...S.tdC,fontWeight:700,color:pct>=70?C.success:pct>=50?C.warning:C.danger}}>{r.assignmentScore}</td>
                    <td style={S.tdC}>{r.maxScore}</td>
                    <td style={S.tdC}><span style={S.badge(pct>=70?"green":pct>=50?"yellow":"red")}>{pct}%</span></td>
                    <td style={{...S.td,fontSize:11,fontStyle:"italic",color:C.textMuted}}>{sub?.feedback||"—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>}
  </div>);
}

// ══════════════════════════════════════════════════════
// SCHOOL DIARY — Daily log + Auto-generated periodic reports
// ══════════════════════════════════════════════════════
function getWeekRange(dateStr){
  const d = new Date(dateStr+"T00:00:00");
  const day = d.getDay(); // 0=Sun
  const diffToMonday = day===0 ? -6 : 1-day;
  const monday = new Date(d);
  monday.setDate(d.getDate()+diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate()+6);
  const fmt = x => x.toISOString().split("T")[0];
  return { start: fmt(monday), end: fmt(sunday) };
}

function DiaryModule({students, staff, diary, setDiary, currentUser}){
  const [tab, setTab] = useState("log");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filterDate, setFilterDate] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  const emptyForm = { date: today(), time: new Date().toTimeString().slice(0,5), event:"", category:"General", recordedBy: currentUser.name };
  const [form, setForm] = useState(emptyForm);

  const CATEGORIES = ["General","Academic","Sports","Discipline","Visitors","Health","Logistics","Staff","Event/Ceremony","Emergency","Others"];
  const CAT_COLORS = {
    General:"blue", Academic:"green", Sports:"yellow", Discipline:"red",
    Visitors:"purple", Health:"red", Logistics:"yellow", Staff:"blue",
    "Event/Ceremony":"green", Emergency:"red", Others:"yellow"
  };

  function openAdd(){ setForm({...emptyForm, date: filterDate||today()}); setEditing(null); setShowForm(true); }
  function openEdit(e){ setForm({...e}); setEditing(e.id); setShowForm(true); }
  function save(){
    if(!form.date||!form.event.trim()) return alert("Date and Event description are required.");
    const entry = { ...form, session: CURRENT_SESSION, term: CURRENT_TERM };
    if(editing){ setDiary(p=>p.map(d=>d.id===editing?{...entry,id:editing}:d)); }
    else{ setDiary(p=>[...p,{...entry,id:genId()}]); }
    setShowForm(false);
  }
  function remove(id){ if(window.confirm("Delete this diary entry?")) setDiary(p=>p.filter(d=>d.id!==id)); }

  const filtered = diary.filter(d=>
    (!filterDate||d.date===filterDate) &&
    (!filterCategory||d.category===filterCategory)
  ).sort((a,b)=> b.date===a.date ? b.time.localeCompare(a.time) : b.date.localeCompare(a.date));

  // Group by date for the log view
  const groupedByDate = {};
  filtered.forEach(d=>{ if(!groupedByDate[d.date]) groupedByDate[d.date]=[]; groupedByDate[d.date].push(d); });
  const sortedDates = Object.keys(groupedByDate).sort((a,b)=>b.localeCompare(a));

  // ── REPORT GENERATION STATE ──
  const [reportScope, setReportScope] = useState("week"); // week | term | session
  const [reportWeekDate, setReportWeekDate] = useState(today());
  const [reportTerm, setReportTerm] = useState(CURRENT_TERM);
  const [reportSession, setReportSession] = useState(CURRENT_SESSION);
  const [generatedReport, setGeneratedReport] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  function getEntriesForScope(){
    if(reportScope==="week"){
      const { start, end } = getWeekRange(reportWeekDate);
      return { entries: diary.filter(d=>d.date>=start&&d.date<=end), label: "Week of "+formatDate(start)+" to "+formatDate(end), start, end };
    }
    if(reportScope==="term"){
      return { entries: diary.filter(d=>d.term===reportTerm&&d.session===reportSession), label: reportTerm+" — "+reportSession };
    }
    return { entries: diary.filter(d=>d.session===reportSession), label: "Full Session — "+reportSession };
  }

  async function generateReport(){
    const { entries, label } = getEntriesForScope();
    if(entries.length===0){ setGenError("No diary entries found for this period. Add some entries first."); return; }
    setGenerating(true); setGenError(""); setGeneratedReport(null);

    const sorted = [...entries].sort((a,b)=> a.date===b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date));
    const entryText = sorted.map(e=> e.date+" "+e.time+" ["+e.category+"] "+e.event).join("\n");

    const catCounts = {};
    entries.forEach(e=>{ catCounts[e.category]=(catCounts[e.category]||0)+1; });

    try{
      const prompt = "You are the school administrator of a Nigerian secondary school writing a formal, comprehensive activity report. " +
        "Below is a raw chronological log of day-to-day school activities for the period: " + label + ". " +
        "Write a professional, well-structured comprehensive report in STRICT JSON format only (no markdown, no preamble, no code fences) with these exact keys: " +
        "summary (a 3-5 sentence executive overview of the period), " +
        "academicHighlights (string, key academic activities/events, or 'None recorded' if none), " +
        "disciplineMatters (string, summary of any discipline issues and how they were handled, or 'No discipline issues recorded'), " +
        "visitorsAndPartnerships (string, summary of visitors/PTA/external engagements, or 'No visitors recorded'), " +
        "healthAndSafety (string, any health/safety/emergency matters, or 'No incidents recorded'), " +
        "logisticsAndOperations (string, facility, materials, staffing matters), " +
        "recommendations (string, 2-3 forward-looking recommendations for the administration based on patterns observed in the log), " +
        "overallAssessment (string, one paragraph closing assessment of how the period went). " +
        "Raw log entries:\n" + entryText;

      const response = await fetch("/api/ai", {
        method: "POST",
        headers: authFetchHeaders(),
        body: JSON.stringify({ prompt, max_tokens: 1500 })
      });
      const data = await response.json();
      if(data.error) throw new Error(data.error);
      const textBlock = data.text ? { text: data.text } : null;
      if(!textBlock) throw new Error("No content returned from generator.");
      let cleaned = textBlock.text.trim().replace(/^```json/,"").replace(/^```/,"").replace(/```$/,"").trim();
      const parsed = JSON.parse(cleaned);

      setGeneratedReport({
        ...parsed,
        label, entries: sorted, catCounts,
        generatedAt: new Date().toISOString(),
        scope: reportScope
      });
    } catch(err){
      console.error(err);
      setGenError("Report generation failed. Please try again. (" + (err.message||"unknown error") + ")");
    } finally{
      setGenerating(false);
    }
  }

  function printReport(){ window.print(); }

  return(<div>
    <div className="no-print" style={{...S.row,marginBottom:14,gap:4,borderBottom:"2px solid "+C.border,paddingBottom:0}}>
      <button style={{...S.btn(tab==="log"?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:12}} onClick={()=>setTab("log")}>📔 Daily Log</button>
      <button style={{...S.btn(tab==="report"?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:12}} onClick={()=>setTab("report")}>📊 Auto Report</button>
    </div>

    {/* ── DAILY LOG TAB ── */}
    {tab==="log"&&<div>
      <div className="no-print" style={{...S.row,marginBottom:12,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={S.row}>
          <input style={S.input} type="date" value={filterDate} onChange={e=>setFilterDate(e.target.value)}/>
          <select style={S.select} value={filterCategory} onChange={e=>setFilterCategory(e.target.value)}>
            <option value="">All Categories</option>
            {CATEGORIES.map(c=><option key={c}>{c}</option>)}
          </select>
          {(filterDate||filterCategory)&&<button style={{...S.btn("secondary"),fontSize:11}} onClick={()=>{setFilterDate("");setFilterCategory("");}}>Clear Filters</button>}
        </div>
        <button style={S.btn()} onClick={openAdd}><span style={S.row}><Icon name="plus" size={13}/>Log New Event</span></button>
      </div>

      <div className="no-print" style={S.statsGrid}>
        {[
          {l:"Total Entries",v:diary.length,bg:"#FFF7ED"},
          {l:"This Week",v:diary.filter(d=>{const {start,end}=getWeekRange(today());return d.date>=start&&d.date<=end;}).length,bg:"#F0FDF4"},
          {l:"This Term",v:diary.filter(d=>d.term===CURRENT_TERM&&d.session===CURRENT_SESSION).length,bg:"#EFF6FF"},
          {l:"Discipline Entries",v:diary.filter(d=>d.category==="Discipline").length,bg:"#FEF2F2"},
        ].map((s,i)=><div key={i} style={S.statCard(s.bg)}><div style={S.statNum}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>)}
      </div>

      {sortedDates.length===0&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No diary entries match your filters. Click "Log New Event" to start recording.</div>}

      {sortedDates.map(date=>(
        <div key={date} style={S.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:13,fontWeight:700,color:"#6B491B",marginBottom:10,paddingBottom:8,borderBottom:"2px solid "+C.border}}>
            <span>{formatDate(date)} <span style={{fontWeight:400,color:C.textMuted,fontSize:11}}>({new Date(date+"T00:00:00").toLocaleDateString("en-NG",{weekday:"long"})})</span></span>
            <span style={{fontSize:11,color:C.textMuted,fontWeight:400}}>{groupedByDate[date].length} event{groupedByDate[date].length!==1?"s":""}</span>
          </div>
          {groupedByDate[date].map(e=>(
            <div key={e.id} style={{display:"flex",gap:12,padding:"9px 0",borderBottom:"1px solid "+C.border,alignItems:"flex-start"}}>
              <div style={{minWidth:50,textAlign:"center",flexShrink:0}}>
                <div style={{fontSize:12,fontWeight:700,color:"#230E6A"}}>{e.time}</div>
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={S.row}><span style={S.badge(CAT_COLORS[e.category]||"blue")}>{e.category}</span><span style={{fontSize:10,color:C.textMuted}}>by {e.recordedBy}</span></div>
                <div style={{fontSize:13,marginTop:4,lineHeight:1.5}}>{e.event}</div>
              </div>
              <div className="no-print" style={S.row}>
                <button style={{...S.btn("ghost"),padding:3}} onClick={()=>openEdit(e)}><Icon name="edit" size={13} color={C.gold}/></button>
                <button style={{...S.btn("ghost"),padding:3}} onClick={()=>remove(e.id)}><Icon name="trash" size={13} color={C.danger}/></button>
              </div>
            </div>
          ))}
        </div>
      ))}

      <Modal open={showForm} onClose={()=>setShowForm(false)} title={editing?"Edit Diary Entry":"Log New Event"}>
        <div style={S.grid3}>
          <div style={S.formGroup}><label style={S.label}>Date *</label><input style={S.input} type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))}/></div>
          <div style={S.formGroup}><label style={S.label}>Time *</label><input style={S.input} type="time" value={form.time} onChange={e=>setForm(p=>({...p,time:e.target.value}))}/></div>
          <div style={S.formGroup}><label style={S.label}>Category</label><select style={{...S.select,width:"100%"}} value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></div>
        </div>
        <div style={S.formGroup}>
          <label style={S.label}>Event Description *</label>
          <textarea style={{...S.textarea,minHeight:90}} value={form.event} onChange={e=>setForm(p=>({...p,event:e.target.value}))} placeholder="Describe what happened..."/>
        </div>
        <div style={S.formGroup}><label style={S.label}>Recorded By</label><input style={S.input} value={form.recordedBy} onChange={e=>setForm(p=>({...p,recordedBy:e.target.value}))}/></div>
        <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}>
          <button style={S.btn("secondary")} onClick={()=>setShowForm(false)}>Cancel</button>
          <button style={S.btn()} onClick={save}>{editing?"Save Changes":"Log Event"}</button>
        </div>
      </Modal>
    </div>}

    {/* ── AUTO REPORT TAB ── */}
    {tab==="report"&&<div>
      <div className="no-print" style={S.card}>
        <div style={S.cardTitle}>📊 Generate Comprehensive Activity Report</div>
        <div style={{fontSize:12,color:C.textMuted,marginBottom:14}}>Select a period below. The AI reads every diary entry logged in that period and writes a full structured report — academic highlights, discipline matters, visitors, health & safety, logistics, and recommendations.</div>

        <div style={S.row}>
          <button style={{...S.btn(reportScope==="week"?"primary":"secondary"),fontSize:12}} onClick={()=>setReportScope("week")}>📅 Weekly</button>
          <button style={{...S.btn(reportScope==="term"?"primary":"secondary"),fontSize:12}} onClick={()=>setReportScope("term")}>📘 Termly</button>
          <button style={{...S.btn(reportScope==="session"?"primary":"secondary"),fontSize:12}} onClick={()=>setReportScope("session")}>🎓 Sessional</button>
        </div>

        <div style={{marginTop:14}}>
          {reportScope==="week"&&<div style={S.formGroup}><label style={S.label}>Pick any date within the week</label><input style={S.input} type="date" value={reportWeekDate} onChange={e=>setReportWeekDate(e.target.value)}/>
            <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>Covers: {reportWeekDate?(formatDate(getWeekRange(reportWeekDate).start)+" to "+formatDate(getWeekRange(reportWeekDate).end)):""}</div>
          </div>}
          {reportScope==="term"&&<div style={S.grid2}>
            <div style={S.formGroup}><label style={S.label}>Term</label><select style={{...S.select,width:"100%"}} value={reportTerm} onChange={e=>setReportTerm(e.target.value)}>{TERMS.map(t=><option key={t}>{t}</option>)}</select></div>
            <div style={S.formGroup}><label style={S.label}>Session</label><select style={{...S.select,width:"100%"}} value={reportSession} onChange={e=>setReportSession(e.target.value)}>{SESSIONS.map(s=><option key={s}>{s}</option>)}</select></div>
          </div>}
          {reportScope==="session"&&<div style={S.formGroup}><label style={S.label}>Session</label><select style={{...S.select,width:"100%"}} value={reportSession} onChange={e=>setReportSession(e.target.value)}>{SESSIONS.map(s=><option key={s}>{s}</option>)}</select></div>}
        </div>

        <div style={{marginTop:6,fontSize:11,color:C.textMuted}}>{getEntriesForScope().entries.length} diary entr{getEntriesForScope().entries.length===1?"y":"ies"} found for this period.</div>

        <button style={{...S.btn("blue"),marginTop:14,padding:"10px 24px",fontSize:13,opacity:generating?0.7:1}} onClick={generateReport} disabled={generating}>
          {generating?"⏳ Generating comprehensive report...":"⚡ Generate Report"}
        </button>
        {genError&&<div style={{color:C.danger,fontSize:12,marginTop:8}}>{genError}</div>}
      </div>

      {generatedReport&&(
        <div style={S.card}>
          <div className="no-print" style={{...S.row,justifyContent:"flex-end",marginBottom:14,gap:8}}>
            <button style={{...S.btn("secondary"),fontSize:12}} onClick={printReport}><span style={S.row}><Icon name="print" size={13}/>Print Report</span></button>
          </div>

          {/* Report header */}
          <div style={{background:"linear-gradient(135deg,#160946,#230E6A)",borderRadius:10,padding:"18px 22px",marginBottom:18,color:"#fff"}}>
            <div style={{...S.row,gap:14}}>
              <SchoolLogoImg size={50}/>
              <div>
                <div style={{fontSize:16,fontWeight:800,color:"#F0C060"}}>{SCHOOL_NAME}</div>
                <div style={{fontSize:10,color:"rgba(255,255,255,0.65)"}}>{SCHOOL_ADDRESS}</div>
              </div>
            </div>
            <div style={{marginTop:12,fontSize:14,fontWeight:700,color:"#F0C060"}}>COMPREHENSIVE ACTIVITY REPORT</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.8)",marginTop:2}}>{generatedReport.label}</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",marginTop:4}}>Generated: {new Date(generatedReport.generatedAt).toLocaleString("en-NG")} · Based on {generatedReport.entries.length} logged entries</div>
          </div>

          {/* Category breakdown */}
          <div style={{marginBottom:18}}>
            <div style={{fontSize:11,fontWeight:700,color:"#230E6A",marginBottom:8}}>ACTIVITY BREAKDOWN BY CATEGORY</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {Object.entries(generatedReport.catCounts).map(([cat,count])=>(
                <span key={cat} style={S.badge(CAT_COLORS[cat]||"blue")}>{cat}: {count}</span>
              ))}
            </div>
          </div>

          {/* Sections */}
          {[
            ["EXECUTIVE SUMMARY", generatedReport.summary],
            ["ACADEMIC HIGHLIGHTS", generatedReport.academicHighlights],
            ["DISCIPLINE MATTERS", generatedReport.disciplineMatters],
            ["VISITORS & PARTNERSHIPS", generatedReport.visitorsAndPartnerships],
            ["HEALTH & SAFETY", generatedReport.healthAndSafety],
            ["LOGISTICS & OPERATIONS", generatedReport.logisticsAndOperations],
          ].map(([label,val])=>val?(
            <div key={label} style={{marginBottom:14,paddingBottom:12,borderBottom:"1px solid "+C.border}}>
              <div style={{fontSize:11,fontWeight:700,color:"#6B491B",letterSpacing:"0.04em",marginBottom:5}}>{label}</div>
              <div style={{fontSize:13,lineHeight:1.7}}>{val}</div>
            </div>
          ):null)}

          {generatedReport.recommendations&&(
            <div style={{background:"#FFFBEB",border:"1px solid #D9CBB0",borderRadius:8,padding:"12px 16px",marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#92400E",marginBottom:5}}>RECOMMENDATIONS</div>
              <div style={{fontSize:13,lineHeight:1.7,whiteSpace:"pre-line"}}>{generatedReport.recommendations}</div>
            </div>
          )}

          {generatedReport.overallAssessment&&(
            <div style={{background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:8,padding:"12px 16px"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#166534",marginBottom:5}}>OVERALL ASSESSMENT</div>
              <div style={{fontSize:13,lineHeight:1.7}}>{generatedReport.overallAssessment}</div>
            </div>
          )}

          {/* Raw log appendix */}
          <div style={{marginTop:20}}>
            <div style={{fontSize:11,fontWeight:700,color:"#230E6A",marginBottom:8}}>APPENDIX — FULL CHRONOLOGICAL LOG</div>
            <table style={S.table}>
              <thead><tr>{["Date","Time","Category","Event","By"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {generatedReport.entries.map(e=>(
                  <tr key={e.id}>
                    <td style={S.td}>{formatDate(e.date)}</td>
                    <td style={S.td}>{e.time}</td>
                    <td style={S.td}><span style={S.badge(CAT_COLORS[e.category]||"blue")}>{e.category}</span></td>
                    <td style={S.td}>{e.event}</td>
                    <td style={S.td}>{e.recordedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{marginTop:20,paddingTop:14,borderTop:"2px solid "+C.border,display:"flex",justifyContent:"space-between",fontSize:10,color:C.textMuted}}>
            <span>Compiled by Assanusiyyah SIS — School Diary Module</span>
            <span>{SCHOOL_MOTTO}</span>
          </div>
        </div>
      )}
    </div>}

    <style>{`@media print { .no-print { display: none !important; } }`}</style>
  </div>);
}
// ══════════════════════════════════════════════════════
// SCHOOL GALLERY — Photos of school activities & events
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// E-LIBRARY — Unrestricted access for all students & staff
// Upload links, PDFs, resources. Browse, search, filter.
// ══════════════════════════════════════════════════════
function ELibraryModule({elibrary, setElibrary, currentUser, students, staff}){
  var _tab = useState("browse"); var tab = _tab[0]; var setTab = _tab[1];
  var _search = useState(""); var search = _search[0]; var setSearch = _search[1];
  var _filterSub = useState(""); var filterSub = _filterSub[0]; var setFilterSub = _filterSub[1];
  var _filterCat = useState(""); var filterCat = _filterCat[0]; var setFilterCat = _filterCat[1];
  var _filterLvl = useState(""); var filterLvl = _filterLvl[0]; var setFilterLvl = _filterLvl[1];
  var _showForm = useState(false); var showForm = _showForm[0]; var setShowForm = _showForm[1];
  var _editing = useState(null); var editing = _editing[0]; var setEditing = _editing[1];
  var _preview = useState(null); var preview = _preview[0]; var setPreview = _preview[1];

  var isAdmin = currentUser.role === "root" || currentUser.role === "admin" || currentUser.role === "Teacher";

  var CATEGORIES = ["Textbook","Past Questions","Reference","Religious Text","Novel / Literature","Dictionary","Notes / Summary","Video Link","Article","Other"];
  var LEVELS = ["All","Primary 1","Primary 2","Primary 3","Primary 4","Primary 5","JSS1","JSS2","JSS3","SS1","SS2","SS3","JSS","SS","Primary"];
  var SUBJECTS_ALL = [...new Set(["Mathematics","English Language","Biology","Chemistry","Physics","Economics","Commerce","Geography","Government","History","Literature in English","Civic Education","Agricultural Science","Computer Science","Further Mathematics","Technical Drawing","Islamic Religious Studies","Christian Religious Studies","French","Yoruba","Hausa","Arabic","Basic Science","Basic Technology","Social Studies","Home Economics","Physical Health Education","Music","Fine Arts"])].sort();

  var emptyForm = {title:"",author:"",subject:"",category:"Textbook",level:"All",type:"link",url:"",description:"",file:""};
  var _form = useState(emptyForm); var form = _form[0]; var setForm = _form[1];

  function openAdd(){ setForm(emptyForm); setEditing(null); setShowForm(true); }
  function openEdit(b){ setForm({...b}); setEditing(b.id); setShowForm(true); }
  function deleteBook(id){ if(window.confirm("Remove this resource from the library?")) setElibrary(function(p){return p.filter(function(b){return b.id!==id;});}); }

  function save(){
    if(!form.title.trim()) return alert("Title is required.");
    if(!form.url && !form.file) return alert("Please provide a URL link or upload a file.");
    var book = {...form, uploadedBy: currentUser.name, uploadedAt: today(), downloads:0, views:0};
    if(editing){
      setElibrary(function(p){return p.map(function(b){return b.id===editing?{...book,id:editing,downloads:b.downloads,views:b.views}:b;});});
    } else {
      setElibrary(function(p){return [{...book, id:genId()}, ...p];});
    }
    setShowForm(false);
  }

  function handleFileUpload(e){
    var file = e.target.files && e.target.files[0];
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(ev){ setForm(function(p){return {...p, file:ev.target.result, type:"pdf", url:""};}); };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function openResource(book){
    // Track view
    setElibrary(function(p){return p.map(function(b){return b.id===book.id?{...b,views:(b.views||0)+1}:b;});});
    if(book.type==="pdf" && book.file){
      setPreview(book);
    } else if(book.url){
      window.open(book.url, "_blank");
    }
  }

  function downloadResource(book){
    if(book.type==="pdf" && book.file){
      setElibrary(function(p){return p.map(function(b){return b.id===book.id?{...b,downloads:(b.downloads||0)+1}:b;});});
      var a = document.createElement("a");
      a.href = book.file;
      a.download = book.title + ".pdf";
      a.click();
    } else if(book.url){
      window.open(book.url, "_blank");
    }
  }

  // All unique subjects in library
  var libSubjects = [...new Set(elibrary.map(function(b){return b.subject;}))].filter(Boolean).sort();
  var libCategories = [...new Set(elibrary.map(function(b){return b.category;}))].filter(Boolean).sort();
  var libLevels = [...new Set(elibrary.map(function(b){return b.level;}))].filter(Boolean).sort();

  var filtered = elibrary.filter(function(b){
    var matchSearch = !search || (b.title+b.author+b.description+b.subject).toLowerCase().indexOf(search.toLowerCase())>=0;
    var matchSub = !filterSub || b.subject===filterSub;
    var matchCat = !filterCat || b.category===filterCat;
    var matchLvl = !filterLvl || b.level===filterLvl || b.level==="All";
    return matchSearch && matchSub && matchCat && matchLvl;
  }).sort(function(a,b){return b.uploadedAt.localeCompare(a.uploadedAt);});

  var CAT_COLORS = {"Textbook":"blue","Past Questions":"green","Reference":"yellow","Religious Text":"gold","Novel / Literature":"purple","Dictionary":"blue","Notes / Summary":"green","Video Link":"red","Article":"yellow","Other":"yellow"};

  function BookCard({book}){
    var catColor = CAT_COLORS[book.category] || "blue";
    return(
      <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:10,padding:"14px 16px",display:"flex",flexDirection:"column",gap:8,boxShadow:"0 1px 4px rgba(0,0,0,0.06)",transition:"box-shadow 0.2s"}}>
        {/* Header row */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,color:"#230E6A",lineHeight:1.3,marginBottom:4}}>{book.title}</div>
            <div style={{fontSize:11,color:"#6B7280"}}>{book.author}</div>
          </div>
          <div style={{fontSize:22,flexShrink:0}}>
            {book.type==="pdf" ? "📄" : book.category==="Video Link" ? "🎬" : "🔗"}
          </div>
        </div>

        {/* Badges */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <span style={S.badge(catColor)}>{book.category}</span>
          {book.subject ? <span style={S.badge("blue")}>{book.subject}</span> : null}
          {book.level && book.level!=="All" ? <span style={S.badge("yellow")}>{book.level}</span> : null}
          {book.type==="pdf" ? <span style={S.badge("green")}>📄 PDF</span> : <span style={S.badge("yellow")}>🔗 Link</span>}
        </div>

        {/* Description */}
        {book.description ? <div style={{fontSize:11,color:"#6B7280",lineHeight:1.5}}>{book.description.length>120?book.description.slice(0,120)+"…":book.description}</div> : null}

        {/* Stats + Actions */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4,paddingTop:8,borderTop:"1px solid #F3F4F6"}}>
          <div style={{display:"flex",gap:12}}>
            <span style={{fontSize:10,color:"#9CA3AF"}}>👁 {book.views||0} views</span>
            <span style={{fontSize:10,color:"#9CA3AF"}}>⬇ {book.downloads||0} downloads</span>
            <span style={{fontSize:10,color:"#9CA3AF"}}>📅 {formatDate(book.uploadedAt)}</span>
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={function(){openResource(book);}} style={{...S.btn("blue"),fontSize:10,padding:"4px 10px"}}>
              {book.type==="pdf" ? "📖 Read" : "🔗 Open"}
            </button>
            {book.type==="pdf" && book.file ? <button onClick={function(){downloadResource(book);}} style={{...S.btn("secondary"),fontSize:10,padding:"4px 10px"}}>⬇ Save</button> : null}
            {isAdmin ? <button onClick={function(){openEdit(book);}} style={{...S.btn("ghost"),fontSize:10,padding:"3px 8px"}}><Icon name="edit" size={12} color="#6B7280"/></button> : null}
            {isAdmin ? <button onClick={function(){deleteBook(book.id);}} style={{...S.btn("ghost"),fontSize:10,padding:"3px 8px"}}><Icon name="trash" size={12} color="#EF4444"/></button> : null}
          </div>
        </div>
      </div>
    );
  }

  // Stats
  var totalBooks = elibrary.length;
  var totalPDFs = elibrary.filter(function(b){return b.type==="pdf";}).length;
  var totalLinks = elibrary.filter(function(b){return b.type==="link";}).length;
  var totalViews = elibrary.reduce(function(a,b){return a+(b.views||0);},0);

  return(
    <div>
      {/* Hero Banner */}
      <div style={{background:"linear-gradient(120deg,#230E6A 0%,#059669 100%)",borderRadius:14,padding:"22px 28px",marginBottom:18,color:"#fff",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:14}}>
        <div>
          <div style={{fontSize:20,fontWeight:900,marginBottom:4}}>📚 Assanusiyyah E-Library</div>
          <div style={{fontSize:12,opacity:0.85}}>Open access for all students and staff — learn without limits</div>
          <div style={{display:"flex",gap:16,marginTop:10}}>
            <span style={{fontSize:11,opacity:0.9}}>📖 {totalBooks} Resources</span>
            <span style={{fontSize:11,opacity:0.9}}>📄 {totalPDFs} PDFs</span>
            <span style={{fontSize:11,opacity:0.9}}>🔗 {totalLinks} Links</span>
            <span style={{fontSize:11,opacity:0.9}}>👁 {totalViews} Total Views</span>
          </div>
        </div>
        {isAdmin ? <button onClick={openAdd} style={{...S.btn(),background:"rgba(255,255,255,0.95)",color:"#230E6A",fontWeight:700,fontSize:12,padding:"9px 18px"}}><span style={{display:"flex",alignItems:"center",gap:6}}><Icon name="plus" size={14} color="#230E6A"/>Add Resource</span></button> : null}
      </div>

      {/* Search + Filters */}
      <div style={{...S.card,marginBottom:14}}>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <div style={{position:"relative",flex:2,minWidth:200}}>
            <span style={{position:"absolute",left:9,top:"50%",transform:"translateY(-50%)"}}><Icon name="search" size={13} color="#9CA3AF"/></span>
            <input style={{...S.input,paddingLeft:30,width:"100%"}} placeholder="Search by title, author, subject, description..." value={search} onChange={function(e){setSearch(e.target.value);}}/>
          </div>
          <select style={S.select} value={filterSub} onChange={function(e){setFilterSub(e.target.value);}}>
            <option value="">All Subjects</option>
            {libSubjects.map(function(s){return <option key={s}>{s}</option>;})}
          </select>
          <select style={S.select} value={filterCat} onChange={function(e){setFilterCat(e.target.value);}}>
            <option value="">All Categories</option>
            {libCategories.map(function(c){return <option key={c}>{c}</option>;})}
          </select>
          <select style={S.select} value={filterLvl} onChange={function(e){setFilterLvl(e.target.value);}}>
            <option value="">All Levels</option>
            {libLevels.map(function(l){return <option key={l}>{l}</option>;})}
          </select>
          {(search||filterSub||filterCat||filterLvl) ? <button style={{...S.btn("secondary"),fontSize:11}} onClick={function(){setSearch("");setFilterSub("");setFilterCat("");setFilterLvl("");}}>Clear</button> : null}
        </div>
        <div style={{fontSize:11,color:"#6B7280",marginTop:8}}>{filtered.length} resource{filtered.length!==1?"s":""} found{search||filterSub||filterCat||filterLvl?" matching your filters":""}</div>
      </div>

      {/* Resource Grid */}
      {filtered.length===0 ? (
        <div style={{...S.card,textAlign:"center",padding:48,color:"#9CA3AF"}}>
          <div style={{fontSize:40,marginBottom:10}}>📭</div>
          <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>No resources found</div>
          <div style={{fontSize:12}}>{elibrary.length===0?"The library is empty. Admins can add books, PDFs and links.":"Try adjusting your search or filters."}</div>
          {isAdmin && elibrary.length===0 ? <button onClick={openAdd} style={{...S.btn(),marginTop:16}}>Add First Resource</button> : null}
        </div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:14}}>
          {filtered.map(function(book){return <BookCard key={book.id} book={book}/>;}) }
        </div>
      )}

      {/* Add / Edit Modal */}
      {showForm ? (
        <Modal open={showForm} onClose={function(){setShowForm(false);}} title={editing?"Edit Resource":"Add Library Resource"} wide>
          <div style={S.grid2}>
            <div style={{...S.formGroup,gridColumn:"1 / -1"}}><label style={S.label}>Title *</label><input style={S.input} value={form.title} onChange={function(e){setForm(function(p){return{...p,title:e.target.value};});}} placeholder="e.g. New General Mathematics for SS1"/></div>
            <div style={S.formGroup}><label style={S.label}>Author / Publisher</label><input style={S.input} value={form.author} onChange={function(e){setForm(function(p){return{...p,author:e.target.value};});}} placeholder="e.g. M.F. Macrae"/></div>
            <div style={S.formGroup}><label style={S.label}>Subject</label><select style={{...S.select,width:"100%"}} value={form.subject} onChange={function(e){setForm(function(p){return{...p,subject:e.target.value};}); }}><option value="">— Select Subject —</option>{SUBJECTS_ALL.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Category</label><select style={{...S.select,width:"100%"}} value={form.category} onChange={function(e){setForm(function(p){return{...p,category:e.target.value};});}}>{CATEGORIES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Level / Class</label><select style={{...S.select,width:"100%"}} value={form.level} onChange={function(e){setForm(function(p){return{...p,level:e.target.value};});}}>{LEVELS.map(function(l){return <option key={l}>{l}</option>;})}</select></div>
          </div>

          <div style={{...S.card,background:"#F0FDF4",border:"1px solid #BBF7D0",marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:700,color:"#059669",marginBottom:10}}>Resource Type</div>
            <div style={{display:"flex",gap:12}}>
              <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12}}>
                <input type="radio" name="restype" checked={form.type==="link"} onChange={function(){setForm(function(p){return{...p,type:"link",file:""};});}} />
                🔗 External URL / Link
              </label>
              <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12}}>
                <input type="radio" name="restype" checked={form.type==="pdf"} onChange={function(){setForm(function(p){return{...p,type:"pdf",url:""};});}} />
                📄 Upload PDF File
              </label>
            </div>
            {form.type==="link" ? (
              <div style={{marginTop:10}}>
                <label style={S.label}>URL *</label>
                <input style={S.input} type="url" value={form.url} onChange={function(e){setForm(function(p){return{...p,url:e.target.value};});}} placeholder="https://www.example.com/book.pdf"/>
                <div style={{fontSize:10,color:"#6B7280",marginTop:4}}>Link to Google Drive, Academia.edu, WAEC website, YouTube, etc.</div>
              </div>
            ) : (
              <div style={{marginTop:10}}>
                <label style={S.label}>Upload PDF</label>
                <input type="file" accept=".pdf,application/pdf" onChange={handleFileUpload}/>
                {form.file ? <div style={{fontSize:10,color:"#059669",marginTop:4}}>✓ PDF loaded</div> : null}
                <div style={{fontSize:10,color:"#EF4444",marginTop:4}}>⚠ Large PDFs increase app size. Use external links for files over 2MB.</div>
              </div>
            )}
          </div>

          <div style={S.formGroup}>
            <label style={S.label}>Description</label>
            <textarea style={{...S.textarea,minHeight:70}} value={form.description} onChange={function(e){setForm(function(p){return{...p,description:e.target.value};});}} placeholder="Brief description of the resource content..."/>
          </div>

          <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:14}}>
            <button style={S.btn("secondary")} onClick={function(){setShowForm(false);}}>Cancel</button>
            <button style={S.btn()} onClick={save}>{editing?"Save Changes":"Add to Library"}</button>
          </div>
        </Modal>
      ) : null}

      {/* PDF Viewer / Preview Modal */}
      {preview ? (
        <div onClick={function(){setPreview(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:2000,display:"flex",flexDirection:"column",alignItems:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:900,background:"#fff",borderRadius:10,overflow:"hidden",maxHeight:"90vh",display:"flex",flexDirection:"column"}} onClick={function(e){e.stopPropagation();}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",borderBottom:"1px solid #E5E7EB",background:"#F9FAFB"}}>
              <div style={{fontSize:13,fontWeight:700,color:"#230E6A"}}>{preview.title}</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={function(){downloadResource(preview);}} style={{...S.btn("blue"),fontSize:11,padding:"4px 10px"}}>⬇ Download</button>
                <button onClick={function(){setPreview(null);}} style={{...S.btn("secondary"),fontSize:11,padding:"4px 10px"}}>✕ Close</button>
              </div>
            </div>
            <iframe src={preview.file} style={{flex:1,border:"none",minHeight:"75vh"}} title={preview.title}/>
          </div>
        </div>
      ) : null}
    </div>
  );
}


function GalleryModule({gallery, setGallery, currentUser, readOnly}){
  const [tab, setTab] = useState("grid");
  const [showForm, setShowForm] = useState(false);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterEvent, setFilterEvent] = useState("");
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const fileInputRef = useRef();

  const CATEGORIES = ["Sports Day","Inter-house Sports","Cultural Day","Graduation","Prize Giving Day","Excursion","Assembly","Classroom Activity","PTA Meeting","Examination","Religious Event","Visitors","Others"];

  const emptyForm = { eventName:"", category:"Others", date: today(), description:"", uploadedBy: currentUser.name, photos: [] };
  const [form, setForm] = useState(emptyForm);
  const [pendingPhotos, setPendingPhotos] = useState([]); // [{dataUrl, caption}]

  function handleFileSelect(e){
    const files = Array.from(e.target.files||[]);
    files.forEach(file=>{
      if(!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = ev => {
        setPendingPhotos(p=>[...p, { dataUrl: ev.target.result, caption: "" }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  }
  function removePending(idx){
    setPendingPhotos(p=>p.filter((_,i)=>i!==idx));
  }
  function updateCaption(idx, caption){
    setPendingPhotos(p=>p.map((ph,i)=>i===idx?{...ph,caption}:ph));
  }

  function saveAlbum(){
    if(!form.eventName.trim()) return alert("Event name is required.");
    if(pendingPhotos.length===0) return alert("Please add at least one photo.");
    const album = {
      ...form,
      id: genId(),
      photos: pendingPhotos.map(p=>({ id: genId(), dataUrl: p.dataUrl, caption: p.caption })),
      uploadedAt: today()
    };
    setGallery(p=>[album, ...p]);
    setShowForm(false);
    setForm(emptyForm);
    setPendingPhotos([]);
  }

  function deleteAlbum(id){
    if(window.confirm("Delete this entire album and all its photos? This cannot be undone.")){
      setGallery(p=>p.filter(a=>a.id!==id));
    }
  }
  function deletePhoto(albumId, photoId){
    if(window.confirm("Remove this photo from the album?")){
      setGallery(p=>p.map(a=>a.id===albumId?{...a,photos:a.photos.filter(ph=>ph.id!==photoId)}:a));
    }
  }

  const filtered = gallery.filter(a=>
    (!filterCategory||a.category===filterCategory) &&
    (!filterEvent||a.eventName.toLowerCase().includes(filterEvent.toLowerCase()))
  ).sort((a,b)=>b.date.localeCompare(a.date));

  // Flatten all photos for lightbox navigation within an album
  function openLightbox(album, photoIndex){
    setLightboxPhoto({ album, photo: album.photos[photoIndex] });
    setLightboxIndex(photoIndex);
  }
  function navigateLightbox(direction){
    if(!lightboxPhoto) return;
    const album = lightboxPhoto.album;
    let newIndex = lightboxIndex + direction;
    if(newIndex < 0) newIndex = album.photos.length - 1;
    if(newIndex >= album.photos.length) newIndex = 0;
    setLightboxIndex(newIndex);
    setLightboxPhoto({ album, photo: album.photos[newIndex] });
  }

  function downloadPhoto(dataUrl, filename){
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename || "photo.jpg";
    a.click();
  }

  const totalPhotos = gallery.reduce((sum,a)=>sum+a.photos.length, 0);
  const categoryCounts = {};
  gallery.forEach(a=>{ categoryCounts[a.category] = (categoryCounts[a.category]||0) + a.photos.length; });

  return(<div>
    <div className="no-print" style={{...S.row,marginBottom:14,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
      <div style={S.row}>
        <select style={S.select} value={filterCategory} onChange={e=>setFilterCategory(e.target.value)}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c=><option key={c}>{c}</option>)}
        </select>
        <input style={{...S.input,width:180}} placeholder="Search event name..." value={filterEvent} onChange={e=>setFilterEvent(e.target.value)}/>
        {(filterCategory||filterEvent)&&<button style={{...S.btn("secondary"),fontSize:11}} onClick={()=>{setFilterCategory("");setFilterEvent("");}}>Clear Filters</button>}
      </div>
      {!readOnly&&<button style={S.btn()} onClick={()=>setShowForm(true)}><span style={S.row}><Icon name="plus" size={13}/>New Album / Upload Photos</span></button>}
    </div>

    <div className="no-print" style={S.statsGrid}>
      {[
        {l:"Total Albums",v:gallery.length,bg:"#F5F3FB"},
        {l:"Total Photos",v:totalPhotos,bg:"#EFF6FF"},
        {l:"This Term",v:gallery.filter(a=>a.date>=today().slice(0,7)+"-01").length,bg:"#F0FDF4"},
        {l:"Categories Used",v:Object.keys(categoryCounts).length,bg:"#FFFBEB"},
      ].map((s,i)=><div key={i} style={S.statCard(s.bg)}><div style={S.statNum}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>)}
    </div>

    {filtered.length===0&&(
      <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
        <div style={{fontSize:36,marginBottom:10}}>🖼️</div>
        <div style={{fontSize:14,fontWeight:600,marginBottom:4}}>No photos yet</div>
        <div style={{fontSize:12}}>Click "New Album / Upload Photos" to start building your school's photo gallery.</div>
      </div>
    )}

    {filtered.map(album=>(
      <div key={album.id} style={S.card}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:8}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#230E6A"}}>{album.eventName}</div>
            <div style={{...S.row,marginTop:4}}>
              <span style={S.badge("blue")}>{album.category}</span>
              <span style={{fontSize:11,color:C.textMuted}}>{formatDate(album.date)}</span>
              <span style={{fontSize:11,color:C.textMuted}}>· {album.photos.length} photo{album.photos.length!==1?"s":""}</span>
              <span style={{fontSize:11,color:C.textMuted}}>· by {album.uploadedBy}</span>
            </div>
            {album.description&&<div style={{fontSize:12,color:C.text,marginTop:6,lineHeight:1.5}}>{album.description}</div>}
          </div>
          {!readOnly&&<button className="no-print" style={{...S.btn("danger"),fontSize:10,padding:"4px 9px"}} onClick={()=>deleteAlbum(album.id)}>Delete Album</button>}
        </div>

        {album.photos.length===0?(
          <div style={{textAlign:"center",color:C.textMuted,padding:16,fontSize:12}}>No photos in this album.</div>
        ):(
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10}}>
            {album.photos.map((photo, idx)=>(
              <div key={photo.id} style={{position:"relative",borderRadius:8,overflow:"hidden",cursor:"pointer",aspectRatio:"1",border:"1px solid "+C.border,background:"#F5F3FB"}}
                onClick={()=>openLightbox(album, idx)}>
                <img src={photo.dataUrl} alt={photo.caption||album.eventName} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                {photo.caption&&(
                  <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(35,14,106,0.8)",padding:"3px 6px"}}>
                    <span style={{fontSize:9,color:"#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",display:"block"}}>{photo.caption}</span>
                  </div>
                )}
                {!readOnly&&<button className="no-print" onClick={e=>{e.stopPropagation();deletePhoto(album.id, photo.id);}}
                  style={{position:"absolute",top:4,right:4,width:20,height:20,borderRadius:"50%",background:"rgba(185,28,28,0.85)",color:"#fff",border:"none",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    ))}

    {/* Upload Modal */}
    <Modal open={showForm} onClose={()=>{setShowForm(false);setPendingPhotos([]);setForm(emptyForm);}} title="New Album / Upload Photos" wide>
      <div style={S.grid3}>
        <div style={S.formGroup}><label style={S.label}>Event Name *</label><input style={S.input} value={form.eventName} onChange={e=>setForm(p=>({...p,eventName:e.target.value}))} placeholder="e.g. Inter-house Sports 2026"/></div>
        <div style={S.formGroup}><label style={S.label}>Category</label><select style={{...S.select,width:"100%"}} value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></div>
        <div style={S.formGroup}><label style={S.label}>Date</label><input style={S.input} type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))}/></div>
      </div>
      <div style={S.formGroup}>
        <label style={S.label}>Description (optional)</label>
        <textarea style={{...S.textarea,minHeight:60}} value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} placeholder="Brief description of the event..."/>
      </div>

      <div style={{background:"#F5F3FB",border:"2px dashed #230E6A55",borderRadius:10,padding:20,textAlign:"center",marginBottom:14}}>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handleFileSelect}/>
        <div style={{fontSize:28,marginBottom:8}}>📷</div>
        <div style={{fontSize:13,fontWeight:600,color:"#230E6A",marginBottom:6}}>Add Photos</div>
        <button style={S.btn()} onClick={()=>fileInputRef.current.click()}>Choose Images</button>
        <div style={{fontSize:10,color:C.textMuted,marginTop:8}}>You can select multiple images at once. JPG, PNG supported.</div>
      </div>

      {pendingPhotos.length>0&&(
        <div>
          <div style={{fontSize:12,fontWeight:700,color:"#230E6A",marginBottom:8}}>{pendingPhotos.length} photo{pendingPhotos.length!==1?"s":""} ready to upload</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:10,maxHeight:280,overflowY:"auto",padding:4}}>
            {pendingPhotos.map((ph,idx)=>(
              <div key={idx} style={{borderRadius:8,overflow:"hidden",border:"1px solid "+C.border}}>
                <div style={{position:"relative",aspectRatio:"1",background:"#F5F3FB"}}>
                  <img src={ph.dataUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                  <button onClick={()=>removePending(idx)} style={{position:"absolute",top:4,right:4,width:20,height:20,borderRadius:"50%",background:"rgba(185,28,28,0.85)",color:"#fff",border:"none",cursor:"pointer",fontSize:11}}>✕</button>
                </div>
                <input style={{...S.input,fontSize:10,padding:"4px 6px",border:"none",borderTop:"1px solid "+C.border,borderRadius:0}} placeholder="Caption (optional)" value={ph.caption} onChange={e=>updateCaption(idx,e.target.value)}/>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{...S.row,justifyContent:"flex-end",marginTop:16,gap:8}}>
        <button style={S.btn("secondary")} onClick={()=>{setShowForm(false);setPendingPhotos([]);setForm(emptyForm);}}>Cancel</button>
        <button style={S.btn()} onClick={saveAlbum}>Save Album ({pendingPhotos.length} photo{pendingPhotos.length!==1?"s":""})</button>
      </div>
    </Modal>

    {/* Lightbox */}
    {lightboxPhoto&&(
      <div className="no-print" onClick={()=>setLightboxPhoto(null)} style={{position:"fixed",inset:0,background:"rgba(15,9,40,0.95)",zIndex:2000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20}}>
        <div style={{position:"absolute",top:16,right:20,display:"flex",gap:10}}>
          <button onClick={e=>{e.stopPropagation();downloadPhoto(lightboxPhoto.photo.dataUrl, lightboxPhoto.album.eventName+"-"+(lightboxIndex+1)+".jpg");}}
            style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:6,color:"#fff",padding:"6px 14px",cursor:"pointer",fontSize:12}}>⬇ Download</button>
          <button onClick={()=>setLightboxPhoto(null)} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:6,color:"#fff",padding:"6px 14px",cursor:"pointer",fontSize:12}}>✕ Close</button>
        </div>

        <button onClick={e=>{e.stopPropagation();navigateLightbox(-1);}} style={{position:"absolute",left:16,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:"50%",color:"#fff",width:42,height:42,cursor:"pointer",fontSize:18}}>‹</button>
        <button onClick={e=>{e.stopPropagation();navigateLightbox(1);}} style={{position:"absolute",right:16,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:"50%",color:"#fff",width:42,height:42,cursor:"pointer",fontSize:18}}>›</button>

        <img src={lightboxPhoto.photo.dataUrl} alt={lightboxPhoto.photo.caption} onClick={e=>e.stopPropagation()} style={{maxWidth:"85%",maxHeight:"75vh",borderRadius:10,boxShadow:"0 20px 60px rgba(0,0,0,0.5)"}}/>

        <div style={{marginTop:16,textAlign:"center",color:"#fff"}}>
          <div style={{fontSize:14,fontWeight:700}}>{lightboxPhoto.album.eventName}</div>
          {lightboxPhoto.photo.caption&&<div style={{fontSize:12,color:"rgba(255,255,255,0.7)",marginTop:4}}>{lightboxPhoto.photo.caption}</div>}
          <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginTop:6}}>{lightboxIndex+1} of {lightboxPhoto.album.photos.length} · {formatDate(lightboxPhoto.album.date)}</div>
        </div>
      </div>
    )}
  </div>);
}




// ══════════════════════════════════════════════════════
// PARENT PORTAL — Separate view for parents
// Login: Admission No. as username, Phone No. as password
// Access: Child's results, attendance, fees, notices
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// SCHOOL CLINIC — Patient presentation, treatment, records
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// SCHOOL CLINIC — Full redesign
// Flow: Class → Student Name → Time → Case → Treatment
// All fields required before submit activates
// Daily patient list, drug combinations, best practices
// ══════════════════════════════════════════════════════
function ClinicModule({students, staff, clinic, setClinic, currentUser, settings}){
  var _tab = useState("present"); var tab = _tab[0]; var setTab = _tab[1];
  var _search = useState(""); var search = _search[0]; var setSearch = _search[1];
  var _filterDate = useState(""); var filterDate = _filterDate[0]; var setFilterDate = _filterDate[1];
  var _viewing = useState(null); var viewing = _viewing[0]; var setViewing = _viewing[1];
  var _showPedDosing = useState(false); var showPedDosing = _showPedDosing[0]; var setShowPedDosing = _showPedDosing[1];
  var _historySel = useState(""); var historySel = _historySel[0]; var setHistorySel = _historySel[1]; // "student:ID" or "staff:ID"
  var _drugPeriod = useState("term"); var drugPeriod = _drugPeriod[0]; var setDrugPeriod = _drugPeriod[1];
  var _drugRefDate = useState(today()); var drugRefDate = _drugRefDate[0]; var setDrugRefDate = _drugRefDate[1];

  // ── Patient selection: Student (Class → Student) or Staff ───────
  var _patientType = useState("Student"); var patientType = _patientType[0]; var setPatientType = _patientType[1];
  var _selClass = useState("JSS1"); var selClass = _selClass[0]; var setSelClass = _selClass[1];
  var _selStudentId = useState(""); var selStudentId = _selStudentId[0]; var setSelStudentId = _selStudentId[1];
  var _selStaffId = useState(""); var selStaffId = _selStaffId[0]; var setSelStaffId = _selStaffId[1];
  var _visitTime = useState(new Date().toLocaleTimeString("en-NG",{hour:"2-digit",minute:"2-digit"}));
  var visitTime = _visitTime[0]; var setVisitTime = _visitTime[1];

  var classStudents = students.filter(function(s){return s.active&&s.class===selClass;}).sort(function(a,b){return (a.surname+a.firstname).localeCompare(b.surname+b.firstname);});
  var activeStaff = staff.filter(function(s){return s.active!==false;}).sort(function(a,b){return (a.surname+a.firstname).localeCompare(b.surname+b.firstname);});
  var foundStudent = selStudentId ? students.find(function(s){return s.id===selStudentId;}) : null;
  var foundStaffPatient = selStaffId ? staff.find(function(s){return s.id===selStaffId;}) : null;
  var foundPatient = patientType==="Staff" ? foundStaffPatient : foundStudent;

  // A clinic record is a student visit unless explicitly marked Staff — keeps
  // pre-existing records (all students, from before staff patients existed)
  // working without a migration.
  function recordPatientId(r){ return r.patientType==="Staff" ? r.staffId : r.studentId; }

  // ── Consultation form ────────────────────────────────
  var emptyForm = {
    presentingConditions:[], otherCondition:"",
    vitalSigns:{temperature:"",pulse:"",bp:"",weight:"",height:""},
    diagnosis:"", treatmentPlan:"", treatmentPractice:"", emergencyProtocol:"",
    medications:[], drugCombination:"",
    nurseName:currentUser.name||"", disposition:"Returned to class",
    followUp:"", notes:""
  };
  var _form = useState(emptyForm); var form = _form[0]; var setForm = _form[1];
  var _newMed = useState({drug:"",dose:"",frequency:"",duration:""});
  var newMed = _newMed[0]; var setNewMed = _newMed[1];
  var _saving = useState(false); var saving = _saving[0]; var setSaving = _saving[1];
  var _saved = useState(false); var saved = _saved[0]; var setSaved = _saved[1];

  // ── Common public health symptoms ────────────────────
  // Kept in sync with TREATMENT_PRACTICES below — every condition here has a
  // matching best-practice protocol, so whichever one a nurse selects, the
  // "Load Best Practice Template" dropdown in STEP 5 is always populated.
  var SYMPTOMS = [
    // General / infectious
    "Headache","Migraine","Fever / Pyrexia","Malaria symptoms","Typhoid symptoms",
    "Chickenpox / Measles-like rash","Vaccination site reaction",
    // Gastrointestinal
    "Stomach ache / Abdominal pain","Vomiting / Nausea","Diarrhoea","Constipation",
    "Food poisoning","Gastroenteritis","Peptic ulcer symptoms / Heartburn","Worm infestation symptoms",
    // Respiratory
    "Cough / Cold / URTI","Sore throat / Pharyngitis","Asthma attack / Difficulty breathing","Sinusitis symptoms",
    // ENT / Eye / Dental
    "Ear pain / Otitis","Nose bleed / Epistaxis","Eye infection / Conjunctivitis","Eye injury / Foreign body in eye",
    "Toothache / Dental pain","Gum infection / Bleeding gums",
    // Skin
    "Skin rash / Dermatitis","Ringworm / Fungal infection","Scabies","Boils / Abscess","Head lice / Pediculosis",
    // Injury / trauma
    "Injury / Wound / Laceration","Minor burns","Sprain / Ankle twist","Suspected fracture",
    "Bruise / Contusion","Insect bite / Sting","Snake bite",
    // Musculoskeletal
    "Back pain","Muscle cramps / Body pain","Joint pain / Arthralgia",
    // Cardio / neuro / emergency
    "Fainting / Syncope","Seizure / Convulsion","Dizziness / Vertigo","Chest pain",
    "Palpitations","Heat exhaustion / Heat stroke","Dehydration",
    // Chronic / metabolic
    "Sickle cell crisis","Hypertension symptoms","Diabetes symptoms / Hyperglycaemia",
    "Hypoglycaemia / Low blood sugar","Anaemia symptoms / Pallor","Malnutrition signs","Allergic reaction",
    // Genitourinary / reproductive
    "Urinary tract infection","Bedwetting / Enuresis","Menstrual pain / Dysmenorrhoea","Irregular menstruation",
    // Mental health
    "Anxiety / Stress / Emotional distress","Panic attack","Insomnia / Sleep difficulty",
    "Others"
  ];

  // ── Best practice treatment plans (Nigerian PHC) ─────
  // One entry per SYMPTOMS item above (except "Others", which is free-text).
  var TREATMENT_PRACTICES = {
    "Headache": "1. Rest in quiet, dark room\n2. Oral hydration\n3. Paracetamol 500mg for adults, weight-based for children\n4. Check blood pressure\n5. Check for signs of meningitis (neck stiffness, photophobia)\n6. Refer if severe, sudden onset, or with neurological signs",
    "Migraine": "1. Rest in a dark, quiet room — reduce light/noise exposure\n2. Cold compress to forehead/temples\n3. Paracetamol or Ibuprofen for pain relief\n4. Encourage sleep if possible\n5. Note triggers (skipped meals, stress, screen time) for follow-up\n6. Refer if first-ever severe headache, vomiting, or vision changes",
    "Fever / Pyrexia": "1. Temperature monitoring every 4 hours\n2. Tepid sponging if temp >38.5°C\n3. Adequate oral hydration (ORS or clean water)\n4. Paracetamol for symptomatic relief\n5. Investigate for malaria if fever persists >48 hours\n6. Refer if temp >39.5°C or convulsions occur",
    "Malaria symptoms": "1. Rapid diagnostic test (RDT) if available\n2. Artemether-Lumefantrine (Coartem) for confirmed malaria\n3. Paracetamol for fever management\n4. Oral rehydration for dehydration\n5. Monitor for cerebral malaria signs\n6. Refer to hospital if severe symptoms or vomiting medication",
    "Typhoid symptoms": "1. Isolate and rest — monitor temperature closely\n2. Ciprofloxacin per standard dosing if confirmed\n3. Paracetamol for fever\n4. Encourage oral fluids and light, soft diet\n5. Watch for abdominal distension or GI bleeding\n6. Refer for lab confirmation (Widal/blood culture) and if symptoms worsen",
    "Chickenpox / Measles-like rash": "1. Isolate student immediately — highly contagious\n2. Calamine lotion for itching\n3. Paracetamol for fever (avoid Aspirin)\n4. Keep nails short to prevent scratching/scarring\n5. Notify school administration for outbreak monitoring\n6. Refer if high fever, breathing difficulty, or signs of secondary infection",
    "Vaccination site reaction": "1. Cold compress to injection site for swelling\n2. Paracetamol for pain/fever if needed\n3. Reassure — mild redness/soreness is normal for 24-48 hours\n4. Monitor for spreading redness or fever >38.5°C\n5. Document vaccine and batch if known\n6. Refer urgently if breathing difficulty, facial swelling, or widespread rash (anaphylaxis)",
    "Stomach ache / Abdominal pain": "1. Rest in comfortable position, knees drawn up if easing pain\n2. Assess location, severity and duration of pain\n3. Warm compress to abdomen (if no signs of appendicitis)\n4. Antacid if related to hunger/indigestion\n5. Monitor for fever, vomiting, or worsening pain\n6. Refer urgently if pain localises to lower right abdomen or is severe/persistent",
    "Vomiting / Nausea": "1. Nothing by mouth for 2 hours if actively vomiting\n2. Small sips of ORS after vomiting settles\n3. Metoclopramide if available for persistent vomiting\n4. Monitor for dehydration\n5. Investigate trigger — food, medication, illness\n6. Refer if blood in vomit or >6 episodes",
    "Diarrhoea": "1. Oral Rehydration Salts (ORS) — prepare and administer\n2. Zinc supplementation for 10-14 days\n3. Continue feeding (no NPO unless vomiting severely)\n4. Monitor hydration status\n5. Metronidazole if dysentery suspected\n6. Refer if dehydrated, blood in stool, or >3 days",
    "Constipation": "1. Encourage fluid intake and fibre-rich foods\n2. Gentle abdominal massage\n3. Mild laxative (e.g. Lactulose) only if needed\n4. Encourage physical activity\n5. Ask about diet, water intake, and toileting habits\n6. Refer if severe pain, vomiting, or no stool for >5 days",
    "Food poisoning": "1. Nothing by mouth until vomiting settles, then ORS\n2. Monitor other students who ate the same food (possible outbreak)\n3. Paracetamol for fever/cramping\n4. Rest and hydration\n5. Notify school administration/caterer if suspected source\n6. Refer if severe dehydration, bloody stool, or multiple affected students",
    "Gastroenteritis": "1. ORS — 200ml after each loose stool\n2. Metronidazole 400mg TDS for 5 days if indicated\n3. Zinc 20mg OD for 10 days\n4. Continue light feeding as tolerated\n5. Monitor hydration status closely\n6. Refer if signs of dehydration, high fever, or symptoms persist >3 days",
    "Peptic ulcer symptoms / Heartburn": "1. Antacid (e.g. Gelusil) for symptomatic relief\n2. Advise small, frequent meals — avoid spicy/oily food\n3. Avoid lying down immediately after eating\n4. Monitor for black stool or vomiting blood\n5. Note frequency and relation to meals\n6. Refer if recurrent, severe, or any sign of GI bleeding",
    "Worm infestation symptoms": "1. Mebendazole (Vermox) per standard dosing\n2. Advise on hand hygiene and footwear\n3. Iron/Folic acid if anaemia suspected\n4. Encourage deworming compliance across household\n5. Monitor weight and growth\n6. Refer if severe abdominal pain, visible worms, or persistent anaemia",
    "Cough / Cold / URTI": "1. Warm fluids and steam inhalation\n2. Paracetamol for fever/discomfort\n3. Cough syrup for symptomatic relief\n4. Vitamin C supplementation\n5. Rest and adequate hydration\n6. Refer if breathing difficulty, chest pain, or symptoms >7 days",
    "Sore throat / Pharyngitis": "1. Warm saline gargle 3-4 times daily\n2. Paracetamol for pain\n3. Encourage warm fluids, avoid cold drinks\n4. Check for tonsillar exudate or swollen glands\n5. Antibiotics only if bacterial infection suspected\n6. Refer if difficulty swallowing/breathing or high fever with white patches",
    "Asthma attack / Difficulty breathing": "1. Sit patient upright — tripod position\n2. Salbutamol inhaler if available (4 puffs via spacer)\n3. Remove from trigger environment\n4. Calm reassurance — reduce anxiety\n5. Oxygen if available\n6. URGENT REFERRAL if no improvement in 15 minutes",
    "Sinusitis symptoms": "1. Steam inhalation for congestion relief\n2. Paracetamol for facial pain/pressure\n3. Warm compress over sinuses\n4. Encourage hydration to thin mucus\n5. Monitor for high fever or facial swelling\n6. Refer if symptoms persist >10 days or severe facial pain/swelling",
    "Ear pain / Otitis": "1. Paracetamol for pain relief\n2. Keep ear dry — no swimming/water entry\n3. Warm compress over affected ear\n4. Check for discharge or visible foreign body\n5. Avoid inserting objects into ear canal\n6. Refer if discharge, hearing loss, or high fever",
    "Nose bleed / Epistaxis": "1. Sit upright, lean slightly forward\n2. Pinch soft part of nose for 10-15 minutes continuously\n3. Cold compress over nasal bridge\n4. Avoid blowing nose for several hours after\n5. Monitor for recurrence\n6. Refer if bleeding persists >20 minutes or is heavy/recurrent",
    "Eye infection / Conjunctivitis": "1. Clean eye with sterile saline, wipe from inner to outer corner\n2. Chloramphenicol eye drops as indicated\n3. Discourage eye rubbing/sharing towels (contagious)\n4. Isolate if highly contagious presentation\n5. Cold compress for discomfort\n6. Refer if severe pain, vision changes, or no improvement in 3 days",
    "Eye injury / Foreign body in eye": "1. Do not rub the eye\n2. Irrigate gently with clean water/saline\n3. Attempt gentle removal of visible foreign body only if superficial\n4. Cover eye loosely if penetrating injury suspected\n5. Check vision in both eyes\n6. URGENT REFERRAL for chemical exposure, penetrating injury, or persistent pain",
    "Toothache / Dental pain": "1. Paracetamol or Ibuprofen for pain relief\n2. Warm saline rinse\n3. Check for visible cavity, swelling, or abscess\n4. Cold compress to cheek if swollen\n5. Avoid very hot/cold/sweet foods\n6. Refer to dentist if swelling, fever, or pain persists >2 days",
    "Gum infection / Bleeding gums": "1. Warm saline rinse 3-4 times daily\n2. Soft-bristled brushing, avoid harsh scrubbing\n3. Paracetamol for discomfort\n4. Check for swelling or pus discharge\n5. Advise on oral hygiene routine\n6. Refer to dentist if persistent bleeding, swelling, or pus",
    "Skin rash / Dermatitis": "1. Identify possible trigger (soap, food, plant, heat)\n2. Calamine lotion or mild antihistamine cream\n3. Chlorphenamine (Piriton) for itching if widespread\n4. Keep area clean and dry\n5. Avoid scratching — trim nails\n6. Refer if spreading rapidly, blistering, or with breathing difficulty",
    "Ringworm / Fungal infection": "1. Keep affected area clean and dry\n2. Topical antifungal cream (e.g. Clotrimazole) BD\n3. Discourage sharing of clothing/towels/combs\n4. Isolate from close contact activities until treated\n5. Continue treatment 1-2 weeks after visible clearing\n6. Refer if widespread, scalp involvement, or no improvement in 2 weeks",
    "Scabies": "1. Isolate — highly contagious via skin contact\n2. Permethrin cream applied as per instructions\n3. Wash all clothing/bedding in hot water\n4. Treat close contacts/household simultaneously\n5. Chlorphenamine for itching\n6. Refer if widespread infection or secondary bacterial infection (pus, fever)",
    "Boils / Abscess": "1. Warm compress 3-4 times daily to encourage drainage\n2. Keep area clean — do not squeeze\n3. Antiseptic dressing once draining\n4. Amoxicillin if signs of spreading infection\n5. Monitor for fever or red streaking (spreading infection)\n6. Refer for incision/drainage if large, deep, or not resolving",
    "Head lice / Pediculosis": "1. Permethrin lotion/shampoo as per instructions\n2. Fine-tooth comb to remove nits after treatment\n3. Wash bedding/clothing/combs in hot water\n4. Discourage sharing of combs, hats, headwear\n5. Check and treat close contacts\n6. Refer if severe scalp infection or no improvement after treatment course",
    "Injury / Wound / Laceration": "1. Control bleeding with direct pressure\n2. Wound irrigation with normal saline\n3. Clean with antiseptic (Gentian violet or Povidone-iodine)\n4. Dress wound appropriately\n5. Assess tetanus immunisation status\n6. Refer for suturing if wound >2cm or deep",
    "Minor burns": "1. Cool burn under running water for 10-20 minutes immediately\n2. Do NOT apply ice, butter, or toothpaste\n3. Cover loosely with sterile non-stick dressing\n4. Paracetamol for pain\n5. Assess burn size/depth\n6. Refer if burn is large, deep, on face/hands/genitals, or blistering extensively",
    "Sprain / Ankle twist": "1. R.I.C.E. — Rest, Ice, Compression, Elevation\n2. Ice pack 15-20 minutes every 2-3 hours (first 24-48 hrs)\n3. Compression bandage, not too tight\n4. Paracetamol/Ibuprofen for pain and swelling\n5. Avoid weight-bearing until pain subsides\n6. Refer if unable to bear weight, severe swelling, or deformity",
    "Suspected fracture": "1. Immobilise the limb — do not attempt to realign\n2. Support with splint using available materials\n3. Apply cold compress around (not on) injury if possible\n4. Do not give food/drink in case surgery is needed\n5. Monitor for numbness, pale skin, or severe pain\n6. URGENT REFERRAL to hospital for X-ray and management",
    "Bruise / Contusion": "1. Cold compress for first 24-48 hours\n2. Elevate affected area if possible\n3. Paracetamol for pain if needed\n4. Monitor size and any spreading discoloration\n5. Reassure — most bruises resolve in 1-2 weeks\n6. Refer if bruising is extensive, unexplained, or with severe pain/swelling",
    "Insect bite / Sting": "1. Remove stinger if visible (scrape, don't squeeze)\n2. Cold compress to reduce swelling\n3. Calamine lotion or antihistamine cream for itching\n4. Chlorphenamine if reaction is more than local\n5. Monitor for spreading swelling or breathing difficulty\n6. URGENT REFERRAL if signs of severe allergic reaction (swelling of face/throat, breathing difficulty)",
    "Snake bite": "1. Keep patient calm and still — minimise movement of affected limb\n2. Immobilise limb at or below heart level\n3. Remove rings/tight clothing near bite site before swelling\n4. Do NOT cut, suck, or apply tourniquet to the wound\n5. Note time of bite and snake description if seen\n6. URGENT REFERRAL to hospital immediately — antivenom may be required",
    "Back pain": "1. Rest in comfortable position — avoid prolonged bed rest\n2. Warm compress to affected area\n3. Paracetamol/Ibuprofen for pain relief\n4. Gentle stretching once acute pain eases\n5. Review bag weight/posture if student carries heavy school bag\n6. Refer if pain radiates to legs, numbness, or persists >1 week",
    "Muscle cramps / Body pain": "1. Gentle stretching of affected muscle\n2. Adequate hydration and electrolyte replacement (ORS)\n3. Warm compress to affected muscle\n4. Paracetamol/Ibuprofen if needed\n5. Rest before returning to physical activity\n6. Refer if recurrent, severe, or associated with weakness",
    "Joint pain / Arthralgia": "1. Rest affected joint, avoid strenuous activity\n2. Cold compress if swollen, warm compress if stiff\n3. Paracetamol/Ibuprofen for pain\n4. Note if single or multiple joints affected\n5. Monitor for swelling, redness, or warmth\n6. Refer if joint is swollen/red/warm, fever present, or pain persists",
    "Fainting / Syncope": "1. Lay patient flat, raise legs above heart level\n2. Loosen tight clothing, ensure fresh air\n3. Check airway, breathing, pulse\n4. Once conscious, give sips of water/ORS if fully alert\n5. Ask about preceding symptoms (hunger, standing too long, heat)\n6. Refer if not regaining consciousness quickly, injury from fall, or recurrent episodes",
    "Seizure / Convulsion": "1. Protect from injury — clear surrounding area, cushion head\n2. Do NOT restrain or put anything in the mouth\n3. Turn onto side (recovery position) once convulsion stops\n4. Time the seizure duration\n5. Stay with patient until fully alert\n6. URGENT REFERRAL if first-ever seizure, lasts >5 minutes, or repeated seizures",
    "Dizziness / Vertigo": "1. Sit or lie down immediately to prevent falls\n2. Check blood pressure and blood sugar if possible\n3. Encourage slow position changes going forward\n4. Ensure adequate hydration\n5. Ask about associated symptoms (ear ringing, vomiting, headache)\n6. Refer if with hearing loss, severe headache, or not resolving with rest",
    "Chest pain": "1. Sit patient upright and calm\n2. Check pulse, breathing rate\n3. Ask about onset, character, and radiation of pain\n4. Do not give food/drink until assessed\n5. Monitor closely for breathing difficulty\n6. URGENT REFERRAL for any chest pain — treat seriously regardless of age",
    "Palpitations": "1. Sit patient down, encourage slow deep breathing\n2. Check pulse rate and regularity\n3. Ask about caffeine/stimulant intake, anxiety, or exertion\n4. Reassure and monitor\n5. Recheck pulse after rest\n6. Refer if persistent, irregular pulse, chest pain, or fainting",
    "Heat exhaustion / Heat stroke": "1. Move to cool, shaded area immediately\n2. Remove excess clothing, fan the patient\n3. Cool with damp cloths/tepid water on skin\n4. Give sips of water/ORS if fully conscious\n5. Monitor temperature and consciousness level closely\n6. URGENT REFERRAL if confusion, very high temperature, or not sweating (heat stroke)",
    "Dehydration": "1. Oral Rehydration Salts (ORS) — small frequent sips\n2. Assess severity (sunken eyes, dry mouth, reduced skin turgor)\n3. Encourage rest in cool environment\n4. Monitor urine output\n5. Identify and address cause (heat, diarrhoea, reduced intake)\n6. Refer if severe dehydration signs, unable to retain fluids, or lethargy",
    "Sickle cell crisis": "1. Adequate hydration (oral or IV if available)\n2. Paracetamol/Ibuprofen for pain management\n3. Warmth — avoid cold environment\n4. Rest in comfortable position\n5. Monitor for fever (sepsis risk)\n6. Refer to hospital — crisis requires specialist care",
    "Hypertension symptoms": "1. Rest patient in quiet setting, recheck BP after 10-15 minutes\n2. Ask about headache, blurred vision, chest pain\n3. Review known history of hypertension/medication compliance\n4. Avoid strenuous activity until reviewed\n5. Document readings over time\n6. Refer if BP very high, symptomatic, or first-time finding",
    "Diabetes symptoms / Hyperglycaemia": "1. Check blood glucose if glucometer available\n2. Encourage water intake, avoid sugary drinks\n3. Ask about known diabetes history/insulin use\n4. Monitor for excessive thirst, urination, fatigue\n5. Watch for signs of ketoacidosis (fruity breath, vomiting, confusion)\n6. URGENT REFERRAL if very high glucose reading or altered consciousness",
    "Hypoglycaemia / Low blood sugar": "1. Give fast-acting sugar immediately (glucose, sweet drink, honey) if conscious\n2. Follow with a small snack once alert\n3. Check blood glucose if glucometer available\n4. Monitor closely for 30 minutes after treatment\n5. Ask about known diabetes/insulin use and last meal\n6. URGENT REFERRAL if unconscious or not improving after sugar given",
    "Anaemia symptoms / Pallor": "1. Note pallor of palms, conjunctiva, and nail beds\n2. Iron and Folic acid supplementation\n3. Advise on iron-rich diet\n4. Ask about worm infestation history, menstrual blood loss\n5. Monitor energy levels and growth\n6. Refer for blood test if severe pallor, fatigue, or breathlessness",
    "Malnutrition signs": "1. Assess weight, height, and mid-upper arm circumference\n2. Multivitamin and Vitamin C supplementation\n3. Refer to school feeding programme/counsellor if available\n4. Discuss home diet with parent/guardian\n5. Monitor growth trend over subsequent visits\n6. Refer to hospital/nutritionist if severe wasting or stunting suspected",
    "Allergic reaction": "1. Remove/avoid the suspected allergen immediately\n2. Chlorphenamine (antihistamine) for mild reactions\n3. Cold compress for localized swelling/itching\n4. Monitor closely for progression (face/throat swelling, breathing difficulty)\n5. Document suspected trigger for future avoidance\n6. URGENT REFERRAL immediately if breathing difficulty, facial/throat swelling, or widespread hives (anaphylaxis risk)",
    "Urinary tract infection": "1. Encourage increased fluid intake\n2. Nitrofurantoin per standard dosing if confirmed/suspected\n3. Paracetamol for discomfort\n4. Advise on hygiene practices\n5. Monitor for fever or flank pain (possible kidney involvement)\n6. Refer if fever, flank pain, blood in urine, or recurrent infections",
    "Bedwetting / Enuresis": "1. Approach sensitively and privately — avoid embarrassment\n2. Ask about frequency, daytime symptoms, and family history\n3. Advise on reduced fluids close to bedtime\n4. Rule out UTI symptoms (pain, urgency, fever)\n5. Involve school counsellor for emotional support if needed\n6. Refer to paediatrician if persistent beyond expected age or with other symptoms",
    "Menstrual pain / Dysmenorrhoea": "1. Warm compress to lower abdomen\n2. Ibuprofen (with food) for pain relief\n3. Rest in a quiet area\n4. Encourage light activity/walking if tolerated\n5. Track cycle regularity and severity over time\n6. Refer if pain is debilitating, unresponsive to analgesia, or heavy bleeding",
    "Irregular menstruation": "1. Approach sensitively and privately\n2. Record cycle history — frequency, duration, flow\n3. Ask about stress, diet, weight changes, exercise levels\n4. Reassure — irregularity is common in adolescence\n5. Involve school counsellor if related to stress/emotional factors\n6. Refer to gynaecologist if very heavy bleeding, severe pain, or persistent irregularity",
    "Anxiety / Stress / Emotional distress": "1. Provide calm, private, non-judgemental space\n2. Active listening — allow student to express concerns\n3. Simple breathing/grounding exercises\n4. Assess for any immediate safety concerns\n5. Involve school counsellor for ongoing support\n6. Refer to counsellor/mental health professional if persistent or severe",
    "Panic attack": "1. Move to a calm, quiet space\n2. Guide slow, deep breathing (in for 4, hold, out for 6)\n3. Reassure — symptoms are frightening but not dangerous\n4. Stay with student until episode passes (usually 10-20 minutes)\n5. Avoid dismissing the experience\n6. Refer to school counsellor for follow-up, especially if recurrent",
    "Insomnia / Sleep difficulty": "1. Discuss sleep hygiene — consistent bedtime, reduced screen time\n2. Ask about stress, workload, or emotional concerns\n3. Encourage relaxation routine before bed\n4. Rule out caffeine/stimulant intake late in day\n5. Monitor impact on daytime functioning\n6. Refer to counsellor if related to anxiety/stress, or persists beyond 2 weeks",
  };

  // ── Emergency / admission protocols (Nigerian PHC) ───
  // One entry per SYMPTOMS item (except "Others"). Covers what TREATMENT_PRACTICES
  // deliberately doesn't: stabilization, drug COMBINATIONS with doses, IV infusion
  // where clinically indicated, and the admit/refer trigger — for the minority of
  // cases where a presenting condition escalates into a genuine emergency. Loaded
  // separately in STEP 5 so routine visits aren't cluttered with emergency-only content.
  var EMERGENCY_PROTOCOLS = {
    "Headache": "⚠ ESCALATE IF: sudden/thunderclap onset, worst-ever headache, neck stiffness, fever, vomiting, or altered consciousness.\n💊 Drug combination: Paracetamol 1g IV/oral + antiemetic (Metoclopramide 10mg) if vomiting.\n💉 Infusion: IV Normal Saline 0.9% at maintenance rate if unable to tolerate oral fluids.\n🚑 ADMIT/REFER: any red-flag feature above — suspect meningitis/raised ICP, refer immediately with airway monitored en route.",
    "Migraine": "⚠ ESCALATE IF: unremitting attack >72 hours (status migrainosus) or new neurological deficit.\n💊 Drug combination: Ibuprofen 400mg + Metoclopramide 10mg (antiemetic + prokinetic combo improves absorption).\n💉 Infusion: IV Normal Saline if dehydrated from repeated vomiting.\n🚑 ADMIT/REFER: neurological deficit, confusion, or failure to respond to combination therapy.",
    "Fever / Pyrexia": "⚠ ESCALATE IF: temp >39.5°C unresponsive to antipyretics, febrile convulsion, or altered consciousness.\n💊 Drug combination: Paracetamol + Artemether-Lumefantrine (if malaria suspected) + ORS.\n💉 Infusion: IV Normal Saline 0.9% bolus 10-20ml/kg if signs of dehydration/shock, then reassess.\n🚑 ADMIT/REFER: hyperpyrexia, seizure, or fever persisting >72 hours despite treatment.",
    "Malaria symptoms": "⚠ ESCALATE IF: repeated vomiting (can't retain oral drugs), altered consciousness, seizures, or jaundice — suspect severe/cerebral malaria.\n💊 Drug combination: IV/IM Artesunate (severe malaria) + Paracetamol for fever; oral Coartem once tolerating orals.\n💉 Infusion: IV Normal Saline or 5% Dextrose-Saline for hydration and to support IV drug administration.\n🚑 ADMIT/REFER: URGENT hospital transfer for any severe-malaria feature — this is a medical emergency.",
    "Typhoid symptoms": "⚠ ESCALATE IF: severe abdominal pain/rigidity (possible perforation), GI bleeding, or high sustained fever with confusion.\n💊 Drug combination: IV Ciprofloxacin or Ceftriaxone + Paracetamol for fever.\n💉 Infusion: IV Normal Saline to maintain hydration, especially if diarrhoea/vomiting present.\n🚑 ADMIT/REFER: URGENT if abdominal rigidity/bleeding suspected (surgical emergency) or toxic appearance.",
    "Chickenpox / Measles-like rash": "⚠ ESCALATE IF: difficulty breathing, drowsiness/confusion, persistent vomiting, or widespread haemorrhagic rash.\n💊 Drug combination: Paracetamol (avoid Aspirin — Reye's syndrome risk) + antihistamine for itching; antibiotics only if secondary bacterial infection.\n💉 Infusion: IV Normal Saline if dehydrated from reduced oral intake.\n🚑 ADMIT/REFER: any breathing difficulty, neurological change, or signs of secondary bacterial infection — notify public health if outbreak suspected.",
    "Vaccination site reaction": "⚠ ESCALATE IF: facial/throat swelling, breathing difficulty, or generalized hives within minutes-hours of vaccination — anaphylaxis.\n💊 Drug combination: IM Adrenaline (Epinephrine) 1:1000 immediately + IM/IV Chlorphenamine + IV Hydrocortisone as follow-up doses.\n💉 Infusion: IV Normal Saline bolus if hypotensive.\n🚑 ADMIT/REFER: URGENT — call for emergency transport immediately on suspicion of anaphylaxis, do not wait.",
    "Stomach ache / Abdominal pain": "⚠ ESCALATE IF: pain localizes/worsens in lower right abdomen, rigid abdomen, or high fever with pain — suspect appendicitis/acute abdomen.\n💊 Drug combination: IV Paracetamol for analgesia (avoid strong analgesics that may mask surgical signs before review) + antispasmodic (Hyoscine) if colicky.\n💉 Infusion: IV Normal Saline, keep nil-by-mouth if surgical abdomen suspected.\n🚑 ADMIT/REFER: URGENT surgical referral for rigid/localized abdomen, guarding, or high fever with pain.",
    "Vomiting / Nausea": "⚠ ESCALATE IF: unable to retain any fluids >12 hours, blood in vomit, or signs of moderate-severe dehydration.\n💊 Drug combination: Metoclopramide 10mg IV/IM + ORS once tolerated.\n💉 Infusion: IV Normal Saline 0.9% — bolus if dehydrated, then maintenance.\n🚑 ADMIT/REFER: signs of dehydration/shock, blood in vomit, or unable to keep IV medication down.",
    "Diarrhoea": "⚠ ESCALATE IF: sunken eyes, very dry mouth, lethargy, or reduced urine output — signs of severe dehydration.\n💊 Drug combination: ORS + Zinc + Metronidazole (if dysentery); avoid anti-motility agents in children.\n💉 Infusion: IV Ringer's Lactate or Normal Saline bolus 20ml/kg for severe dehydration, reassess and repeat as needed.\n🚑 ADMIT/REFER: URGENT for severe dehydration, blood in stool, or shock — this can be life-threatening in children.",
    "Constipation": "⚠ ESCALATE IF: severe distension, vomiting, or complete inability to pass stool/gas — possible obstruction.\n💊 Drug combination: not applicable for routine cases; obstruction requires hospital management, not laxatives.\n💉 Infusion: IV Normal Saline if vomiting/dehydrated while awaiting referral.\n🚑 ADMIT/REFER: URGENT if distension with vomiting or no stool/flatus for several days.",
    "Food poisoning": "⚠ ESCALATE IF: multiple students affected simultaneously, severe dehydration, or bloody diarrhoea — possible outbreak.\n💊 Drug combination: ORS + Metoclopramide for vomiting + Metronidazole if dysentery features.\n💉 Infusion: IV Normal Saline bolus for dehydrated/shocked patients.\n🚑 ADMIT/REFER: URGENT if multiple casualties, severe dehydration, or bloody stool — notify school administration and public health.",
    "Gastroenteritis": "⚠ ESCALATE IF: signs of moderate-severe dehydration or persistent high fever.\n💊 Drug combination: ORS + Zinc + Metronidazole 400mg TDS if dysentery suspected.\n💉 Infusion: IV Ringer's Lactate/Normal Saline 20ml/kg bolus for dehydration, then maintenance.\n🚑 ADMIT/REFER: dehydration not correcting with oral therapy, or high fever with lethargy.",
    "Peptic ulcer symptoms / Heartburn": "⚠ ESCALATE IF: vomiting blood, black tarry stool, or sudden severe abdominal pain — possible bleed/perforation.\n💊 Drug combination: IV Omeprazole (if available) + antacid; avoid NSAIDs.\n💉 Infusion: IV Normal Saline if hypovolaemic from bleeding.\n🚑 ADMIT/REFER: URGENT for any GI bleeding sign or sudden severe pain — surgical emergency possible.",
    "Worm infestation symptoms": "⚠ ESCALATE IF: severe abdominal distension/pain with vomiting — possible bowel obstruction from heavy worm load.\n💊 Drug combination: Mebendazole once obstruction excluded; Iron/Folic acid for associated anaemia.\n💉 Infusion: IV Normal Saline if vomiting/dehydrated.\n🚑 ADMIT/REFER: obstruction signs, severe anaemia, or failure to respond to deworming.",
    "Cough / Cold / URTI": "⚠ ESCALATE IF: fast/laboured breathing, chest indrawing, or blue lips — possible pneumonia/respiratory distress.\n💊 Drug combination: Amoxicillin (if bacterial pneumonia suspected) + Paracetamol; Salbutamol nebulization if wheeze present.\n💉 Infusion: IV Normal Saline if unable to feed/drink due to respiratory distress.\n🚑 ADMIT/REFER: URGENT for chest indrawing, cyanosis, or oxygen saturation concerns.",
    "Sore throat / Pharyngitis": "⚠ ESCALATE IF: difficulty swallowing own saliva (drooling), muffled voice, or stridor — possible airway-threatening infection.\n💊 Drug combination: IV Ceftriaxone/Amoxicillin + Paracetamol/Ibuprofen for pain.\n💉 Infusion: IV Normal Saline to maintain hydration if swallowing is painful/difficult.\n🚑 ADMIT/REFER: URGENT for drooling, stridor, or muffled voice — risk of airway obstruction (e.g. epiglottitis, peritonsillar abscess).",
    "Asthma attack / Difficulty breathing": "⚠ ESCALATE IF: unable to speak full sentences, silent chest, exhaustion, or no response to inhaler after repeated doses.\n💊 Drug combination: Salbutamol nebulized/inhaler (back-to-back doses) + IV Hydrocortisone + Ipratropium bromide if severe.\n💉 Infusion: IV Normal Saline maintenance; oxygen if available (not a drug but essential).\n🚑 ADMIT/REFER: URGENT — life-threatening asthma requires immediate hospital transfer with oxygen en route.",
    "Sinusitis symptoms": "⚠ ESCALATE IF: eye swelling/redness, severe headache, or altered consciousness — rare orbital/intracranial spread.\n💊 Drug combination: Amoxicillin + Paracetamol for pain; decongestant for symptomatic relief.\n💉 Infusion: not typically required for uncomplicated sinusitis.\n🚑 ADMIT/REFER: URGENT for eye swelling, severe headache, or neurological signs.",
    "Ear pain / Otitis": "⚠ ESCALATE IF: swelling behind the ear, high fever, or severe headache — possible mastoiditis.\n💊 Drug combination: Amoxicillin + Paracetamol for pain.\n💉 Infusion: not typically required.\n🚑 ADMIT/REFER: swelling behind ear, persistent high fever, or signs of spreading infection.",
    "Nose bleed / Epistaxis": "⚠ ESCALATE IF: bleeding uncontrolled after 20+ minutes of direct pressure, or recurrent heavy bleeds.\n💊 Drug combination: none specific — focus on mechanical control (pressure, nasal packing if trained).\n💉 Infusion: IV Normal Saline if significant blood loss/dizziness/low BP.\n🚑 ADMIT/REFER: URGENT for uncontrolled bleeding, signs of significant blood loss, or recurrent unexplained bleeds.",
    "Eye infection / Conjunctivitis": "⚠ ESCALATE IF: severe pain, vision loss, or eyelid swelling with fever — possible orbital cellulitis.\n💊 Drug combination: topical Chloramphenicol + oral Amoxicillin if spreading infection suspected.\n💉 Infusion: not typically required for simple conjunctivitis.\n🚑 ADMIT/REFER: URGENT for vision changes, severe pain, or eyelid/orbital swelling.",
    "Eye injury / Foreign body in eye": "⚠ ESCALATE IF: penetrating injury, chemical exposure, or foreign body not easily removed.\n💊 Drug combination: copious irrigation is the priority treatment for chemical exposure — not a drug combination scenario.\n💉 Infusion: IV analgesia (Paracetamol) if in significant pain awaiting transfer.\n🚑 ADMIT/REFER: URGENT for any penetrating injury or chemical burn — irrigate continuously en route to hospital.",
    "Toothache / Dental pain": "⚠ ESCALATE IF: facial swelling spreading to neck/floor of mouth, difficulty swallowing/breathing — possible Ludwig's angina.\n💊 Drug combination: IV/oral Amoxicillin + Metronidazole (dental infection combination) + Paracetamol/Ibuprofen for pain.\n💉 Infusion: IV Normal Saline if unable to swallow due to pain/swelling.\n🚑 ADMIT/REFER: URGENT for spreading facial/neck swelling or breathing/swallowing difficulty.",
    "Gum infection / Bleeding gums": "⚠ ESCALATE IF: facial swelling, fever, or spreading infection.\n💊 Drug combination: Amoxicillin + Metronidazole combination for dental/gum infections.\n💉 Infusion: not typically required unless systemically unwell.\n🚑 ADMIT/REFER: facial swelling, fever, or infection not responding to antibiotics.",
    "Skin rash / Dermatitis": "⚠ ESCALATE IF: widespread blistering/skin peeling, mucosal involvement, or fever — possible severe drug reaction (Stevens-Johnson syndrome).\n💊 Drug combination: IV Hydrocortisone + Chlorphenamine for severe reactions; stop any suspected causative medication immediately.\n💉 Infusion: IV Normal Saline for fluid losses if extensive skin involvement.\n🚑 ADMIT/REFER: URGENT for blistering/peeling skin, mucosal involvement, or fever with rash.",
    "Ringworm / Fungal infection": "⚠ ESCALATE IF: rare — widespread infection with secondary bacterial cellulitis.\n💊 Drug combination: topical antifungal + oral Amoxicillin only if secondary bacterial infection present.\n💉 Infusion: not applicable.\n🚑 ADMIT/REFER: only if secondary infection causes spreading redness/fever.",
    "Scabies": "⚠ ESCALATE IF: widespread secondary bacterial infection with fever (crusted/severe scabies).\n💊 Drug combination: Permethrin + oral Amoxicillin if secondary infection/sepsis signs present.\n💉 Infusion: IV Normal Saline if systemically unwell/septic.\n🚑 ADMIT/REFER: fever, spreading redness, or signs of sepsis from secondary infection.",
    "Boils / Abscess": "⚠ ESCALATE IF: red streaking from the boil, high fever, or the boil is large/deep — possible spreading cellulitis/sepsis.\n💊 Drug combination: IV/oral Amoxicillin + Metronidazole if spreading cellulitis; incision and drainage often needed for large abscesses.\n💉 Infusion: IV Normal Saline if systemically unwell/septic.\n🚑 ADMIT/REFER: red streaking, high fever, or abscess too large/deep for safe drainage at school level.",
    "Head lice / Pediculosis": "⚠ ESCALATE IF: rare — secondary infected scalp sores with spreading redness/fever.\n💊 Drug combination: Permethrin + oral Amoxicillin only if secondary bacterial infection.\n💉 Infusion: not applicable.\n🚑 ADMIT/REFER: only if secondary scalp infection with fever/spreading redness.",
    "Injury / Wound / Laceration": "⚠ ESCALATE IF: bleeding not controlled with direct pressure, wound is deep/large, or signs of shock (pale, cold, rapid pulse).\n💊 Drug combination: IV Paracetamol for pain + Amoxicillin if contaminated wound + tetanus toxoid.\n💉 Infusion: IV Normal Saline/Ringer's Lactate bolus if signs of significant blood loss/shock.\n🚑 ADMIT/REFER: URGENT for uncontrolled bleeding, deep wounds needing suturing, or shock.",
    "Minor burns": "⚠ ESCALATE IF: burn is large (>10% body surface), full-thickness, involves face/hands/genitals, or circumferential.\n💊 Drug combination: IV Paracetamol/Ibuprofen for pain + Amoxicillin if signs of infection.\n💉 Infusion: IV Ringer's Lactate per burns fluid resuscitation protocol for large burns — refer for exact calculation.\n🚑 ADMIT/REFER: URGENT for large/deep burns, or burns to face/hands/genitals/airway involvement.",
    "Sprain / Ankle twist": "⚠ ESCALATE IF: severe swelling with numbness/pale limb, or unable to bear any weight — rule out fracture/compartment syndrome.\n💊 Drug combination: Ibuprofen + Paracetamol combination for pain/inflammation.\n💉 Infusion: not typically required.\n🚑 ADMIT/REFER: suspected fracture, numbness, or pale/cold limb distal to injury.",
    "Suspected fracture": "⚠ ESCALATE IF: open fracture (bone through skin), deformity, or numbness/pale limb distal to injury — neurovascular compromise.\n💊 Drug combination: IV Paracetamol + Ibuprofen for pain (avoid food/drink in case surgery needed).\n💉 Infusion: IV Normal Saline if in significant pain/shock, keep nil-by-mouth.\n🚑 ADMIT/REFER: URGENT for all suspected fractures, especially open fractures or neurovascular compromise.",
    "Bruise / Contusion": "⚠ ESCALATE IF: extensive unexplained bruising, bruising with bleeding from gums/nose, or suspected bleeding disorder.\n💊 Drug combination: Paracetamol for pain — avoid Ibuprofen/Aspirin if bleeding disorder suspected.\n💉 Infusion: not typically required.\n🚑 ADMIT/REFER: extensive/unexplained bruising or associated bleeding from other sites.",
    "Insect bite / Sting": "⚠ ESCALATE IF: facial/throat swelling, breathing difficulty, or widespread hives — anaphylaxis.\n💊 Drug combination: IM Adrenaline 1:1000 immediately for anaphylaxis + IV Chlorphenamine + IV Hydrocortisone.\n💉 Infusion: IV Normal Saline bolus if hypotensive.\n🚑 ADMIT/REFER: URGENT — do not delay adrenaline administration if anaphylaxis suspected.",
    "Snake bite": "⚠ ESCALATE IF: any snake bite — always treat as potentially serious until proven otherwise.\n💊 Drug combination: Antivenom (hospital-administered only) + IV Paracetamol for pain — avoid Aspirin/NSAIDs (bleeding risk).\n💉 Infusion: IV Normal Saline/Ringer's Lactate to maintain circulation en route to hospital.\n🚑 ADMIT/REFER: URGENT — immediate hospital transfer required for antivenom; immobilise limb, do not cut/suck the wound.",
    "Back pain": "⚠ ESCALATE IF: loss of bladder/bowel control, numbness in groin/legs, or progressive leg weakness — possible cauda equina (rare).\n💊 Drug combination: Ibuprofen + Paracetamol combination for pain.\n💉 Infusion: not typically required.\n🚑 ADMIT/REFER: URGENT for any bladder/bowel/leg weakness symptoms — surgical emergency.",
    "Muscle cramps / Body pain": "⚠ ESCALATE IF: dark/tea-coloured urine with severe muscle pain — possible rhabdomyolysis (rare, e.g. after extreme exertion).\n💊 Drug combination: ORS/electrolyte replacement + Paracetamol for pain.\n💉 Infusion: IV Normal Saline if dark urine/severe muscle breakdown suspected.\n🚑 ADMIT/REFER: dark urine with muscle pain, or cramps not resolving with rest/hydration.",
    "Joint pain / Arthralgia": "⚠ ESCALATE IF: single hot, swollen, red joint with fever — possible septic arthritis (surgical emergency).\n💊 Drug combination: IV Ceftriaxone (if septic arthritis suspected) + Paracetamol/Ibuprofen for pain.\n💉 Infusion: IV Normal Saline if systemically unwell.\n🚑 ADMIT/REFER: URGENT for hot/swollen/red single joint with fever.",
    "Fainting / Syncope": "⚠ ESCALATE IF: not regaining consciousness quickly, injury from the fall, chest pain preceding the episode, or recurrent episodes.\n💊 Drug combination: none specific for simple faint — glucose if hypoglycaemia suspected/confirmed.\n💉 Infusion: IV Normal Saline if prolonged unconsciousness or dehydration contributed.\n🚑 ADMIT/REFER: URGENT for prolonged unconsciousness, injury, chest pain, or recurrent fainting — cardiac cause must be excluded.",
    "Seizure / Convulsion": "⚠ ESCALATE IF: seizure lasts >5 minutes, repeated seizures without regaining consciousness (status epilepticus), or first-ever seizure.\n💊 Drug combination: Diazepam (rectal/IV) as first-line anticonvulsant + glucose check/correction if hypoglycaemic.\n💉 Infusion: IV Normal Saline once accessible; IV Dextrose if hypoglycaemia confirmed.\n🚑 ADMIT/REFER: URGENT for status epilepticus, first-ever seizure, or seizure with injury.",
    "Dizziness / Vertigo": "⚠ ESCALATE IF: sudden onset with slurred speech, facial droop, limb weakness, or severe imbalance — possible stroke-like presentation.\n💊 Drug combination: none specific for simple vertigo — treat underlying cause (hydration, rest).\n💉 Infusion: IV Normal Saline if dehydration-related.\n🚑 ADMIT/REFER: URGENT for any stroke-like features (facial droop, slurred speech, limb weakness) — treat as time-critical.",
    "Chest pain": "⚠ ESCALATE IF: any chest pain in a school setting — treat seriously regardless of age.\n💊 Drug combination: IV Paracetamol for analgesia while assessing — avoid Aspirin unless cardiac cause confirmed by a physician.\n💉 Infusion: IV Normal Saline keep-vein-open access while arranging transfer.\n🚑 ADMIT/REFER: URGENT for all chest pain — immediate hospital transfer, monitor airway/breathing/pulse en route.",
    "Palpitations": "⚠ ESCALATE IF: irregular pulse, chest pain, fainting, or breathlessness accompanying palpitations.\n💊 Drug combination: not applicable at school level — arrhythmia management requires ECG assessment in hospital.\n💉 Infusion: IV access for monitoring if arranging transfer.\n🚑 ADMIT/REFER: URGENT for irregular pulse, chest pain, or fainting with palpitations — possible arrhythmia.",
    "Heat exhaustion / Heat stroke": "⚠ ESCALATE IF: temperature >40°C, confusion, or not sweating despite heat (heat stroke) — life-threatening.\n💊 Drug combination: Paracetamol is NOT effective for heat stroke — active cooling is the priority treatment.\n💉 Infusion: IV Normal Saline/Ringer's Lactate bolus for rehydration and to support cooling and circulation.\n🚑 ADMIT/REFER: URGENT for confusion, very high temperature, or absent sweating — cool aggressively en route.",
    "Dehydration": "⚠ ESCALATE IF: sunken eyes, very dry mouth, lethargy/unconsciousness, or unable to retain oral fluids.\n💊 Drug combination: ORS for mild-moderate; treat underlying cause (diarrhoea, vomiting, heat).\n💉 Infusion: IV Ringer's Lactate/Normal Saline bolus 20ml/kg for severe dehydration, reassess and repeat.\n🚑 ADMIT/REFER: URGENT for severe dehydration signs or failure to respond to IV fluids.",
    "Sickle cell crisis": "⚠ ESCALATE IF: severe pain unresponsive to standard analgesia, fever, chest pain, or breathing difficulty (acute chest syndrome).\n💊 Drug combination: IV Paracetamol + Ibuprofen/Diclofenac combination for pain; escalate to stronger analgesia in hospital if needed.\n💉 Infusion: IV Normal Saline for hydration — key part of crisis management alongside pain control.\n🚑 ADMIT/REFER: URGENT for severe unremitting pain, fever, or breathing difficulty — sickle cell crisis requires specialist care.",
    "Hypertension symptoms": "⚠ ESCALATE IF: very high BP reading with headache, vision changes, chest pain, or confusion — hypertensive emergency.\n💊 Drug combination: hospital-administered antihypertensives only — do not initiate new antihypertensive therapy at school level.\n💉 Infusion: IV access for monitoring while arranging urgent transfer.\n🚑 ADMIT/REFER: URGENT for very high BP with any symptoms — this is a medical emergency, not routine hypertension.",
    "Diabetes symptoms / Hyperglycaemia": "⚠ ESCALATE IF: fruity breath odour, deep rapid breathing, vomiting, or confusion — possible diabetic ketoacidosis (DKA).\n💊 Drug combination: hospital-administered insulin protocol only — do not attempt insulin correction at school level.\n💉 Infusion: IV Normal Saline while arranging urgent transfer (rehydration is first step of DKA management).\n🚑 ADMIT/REFER: URGENT for any DKA features — this is a life-threatening emergency requiring hospital management.",
    "Hypoglycaemia / Low blood sugar": "⚠ ESCALATE IF: unconscious or unable to swallow safely — cannot give oral sugar.\n💊 Drug combination: IV Dextrose 10% or IM Glucagon if unconscious/unable to swallow; oral glucose if conscious.\n💉 Infusion: IV Dextrose 10% bolus, then maintenance infusion until stable and eating normally.\n🚑 ADMIT/REFER: URGENT if unconscious, not improving after treatment, or recurrent episodes.",
    "Anaemia symptoms / Pallor": "⚠ ESCALATE IF: breathlessness at rest, rapid heart rate, or fainting — possible severe anaemia/high-output heart failure.\n💊 Drug combination: Iron/Folic acid is NOT sufficient for severe symptomatic anaemia — hospital transfusion may be required.\n💉 Infusion: IV Normal Saline keep-vein-open access while arranging urgent transfer (blood transfusion needs hospital setting).\n🚑 ADMIT/REFER: URGENT for breathlessness at rest, rapid heart rate, or fainting with pallor.",
    "Malnutrition signs": "⚠ ESCALATE IF: severe wasting, bilateral leg swelling (oedema), or associated infection/dehydration — severe acute malnutrition.\n💊 Drug combination: cautious refeeding under supervision — avoid rapid high-calorie feeding (refeeding syndrome risk).\n💉 Infusion: IV fluids only under hospital supervision — rapid fluid administration is dangerous in severe malnutrition.\n🚑 ADMIT/REFER: URGENT for severe wasting, oedema, or malnutrition with infection.",
    "Allergic reaction": "⚠ ESCALATE IF: facial/throat swelling, breathing difficulty, widespread hives, or dizziness/collapse — anaphylaxis.\n💊 Drug combination: IM Adrenaline 1:1000 immediately (first-line, do not substitute) + IV Chlorphenamine + IV Hydrocortisone as follow-up.\n💉 Infusion: IV Normal Saline bolus for hypotension.\n🚑 ADMIT/REFER: URGENT — administer adrenaline without delay and transfer immediately; observe for biphasic reaction even after improvement.",
    "Urinary tract infection": "⚠ ESCALATE IF: fever, flank/back pain, or vomiting — possible pyelonephritis/urosepsis.\n💊 Drug combination: IV Ceftriaxone (if urosepsis suspected) + Paracetamol for fever; oral Nitrofurantoin for uncomplicated cases.\n💉 Infusion: IV Normal Saline if febrile/dehydrated/vomiting.\n🚑 ADMIT/REFER: URGENT for fever with flank pain, vomiting, or signs of systemic infection.",
    "Bedwetting / Enuresis": "⚠ ESCALATE IF: rare — associated with fever, pain, or new-onset in a previously dry child (may indicate underlying illness).\n💊 Drug combination: not applicable — investigate underlying cause rather than treat as emergency.\n💉 Infusion: not applicable.\n🚑 ADMIT/REFER: only if associated with fever, pain, or other concerning new symptoms.",
    "Menstrual pain / Dysmenorrhoea": "⚠ ESCALATE IF: extremely heavy bleeding (soaking pad hourly), severe pain unresponsive to analgesia, or signs of anaemia/dizziness.\n💊 Drug combination: Ibuprofen + Hyoscine (Buscopan) combination for severe cramping.\n💉 Infusion: IV Normal Saline if dizzy/hypovolaemic from heavy bleeding.\n🚑 ADMIT/REFER: heavy bleeding soaking a pad hourly, severe unresponsive pain, or dizziness/pallor.",
    "Irregular menstruation": "⚠ ESCALATE IF: very heavy prolonged bleeding with dizziness/pallor — possible significant blood loss.\n💊 Drug combination: Iron/Folic acid supplementation if associated anaemia; Ibuprofen for pain if present.\n💉 Infusion: IV Normal Saline if dizzy/hypovolaemic from heavy bleeding.\n🚑 ADMIT/REFER: very heavy/prolonged bleeding with dizziness or pallor — needs gynaecological assessment.",
    "Anxiety / Stress / Emotional distress": "⚠ ESCALATE IF: expressed thoughts of self-harm, severe agitation, or inability to calm/reassure.\n💊 Drug combination: not applicable at school level — this requires psychological/safeguarding response, not medication.\n💉 Infusion: not applicable.\n🚑 ADMIT/REFER: URGENT and confidential referral to school counsellor/safeguarding lead for any self-harm or safety concern — treat as a priority alongside physical emergencies.",
    "Panic attack": "⚠ ESCALATE IF: chest pain, breathlessness not improving with reassurance, or first-ever episode in someone with cardiac risk factors.\n💊 Drug combination: not applicable at school level — breathing/grounding techniques are first-line, not medication.\n💉 Infusion: not applicable.\n🚑 ADMIT/REFER: if chest pain or breathlessness persists despite calming measures, treat as possible cardiac/respiratory cause and refer.",
    "Insomnia / Sleep difficulty": "⚠ ESCALATE IF: rare — associated with severe mood disturbance or safety concerns.\n💊 Drug combination: not applicable — sedatives are not appropriate for school-level management of adolescent insomnia.\n💉 Infusion: not applicable.\n🚑 ADMIT/REFER: refer to counsellor if linked to mood/anxiety; refer urgently if any safety concern disclosed.",
  };

  // ── Drug combinations ─────────────────────────────────
  var DRUG_COMBOS = [
    {name:"Malaria (Adult)", drugs:["Artemether-Lumefantrine (Coartem) — 4 tabs BD for 3 days","Paracetamol 500mg — 1-2 tabs TDS for 3 days","ORS — as needed for hydration"]},
    {name:"Malaria (Child)", drugs:["Artemether-Lumefantrine (Coartem) — weight-based BD x3 days","Paracetamol syrup — 15mg/kg/dose TDS","ORS sachet — as tolerated"]},
    {name:"Typhoid", drugs:["Ciprofloxacin 500mg — BD for 7 days","Paracetamol 500mg — TDS for fever","Vitamin C 500mg — OD","Oral rehydration as needed"]},
    {name:"UTI (Female)", drugs:["Nitrofurantoin 100mg — BD for 5 days","Metronidazole 400mg — TDS for 5 days","Vitamin C 500mg — OD"]},
    {name:"Wound/Injury", drugs:["Normal Saline — wound irrigation","Povidone-iodine — wound cleaning","Amoxicillin 500mg — TDS for 5 days (if infected)","Paracetamol 500mg — TDS for pain","Tetanus toxoid if not vaccinated"]},
    {name:"URTI/Cold", drugs:["Paracetamol 500mg — TDS for 3 days","Vitamin C 500mg — OD for 5 days","Antihistamine (Chlorphenamine) — BD","Warm saline gargle — TDS"]},
    {name:"Gastroenteritis", drugs:["ORS — 200ml after each loose stool","Metronidazole 400mg — TDS for 5 days","Zinc 20mg — OD for 10 days","Probiotics if available"]},
    {name:"Menstrual Pain", drugs:["Ibuprofen 400mg — TDS with food for 3 days","Hyoscine (Buscopan) — TDS if cramping","Vitamin B complex — OD","Hot compress to abdomen"]},
  ];

  var COMMON_DRUGS = [
    "Paracetamol 500mg","Ibuprofen 400mg","Artemether-Lumefantrine (Coartem)","Metronidazole 400mg",
    "Amoxicillin 500mg","Ciprofloxacin 500mg","ORS Sachet","Zinc 20mg","Vitamin C 500mg",
    "Vitamin B Complex","Chlorphenamine (Piriton)","Antacid (Gelusil)","Normal Saline","Povidone-iodine",
    "Gentian Violet","Eye drops (Chloramphenicol)","Salbutamol inhaler","Hyoscine (Buscopan)",
    "Cotrimoxazole","Nitrofurantoin 100mg","Iron tablet","Folic acid","Multivitamin",
    "Cough syrup","Mebendazole (Vermox)"
  ];

  // ── Pediatric / weight-based dosing reference ─────────
  // Every dose written into TREATMENT_PRACTICES / EMERGENCY_PROTOCOLS above is a
  // flat adolescent/adult dose (e.g. "Paracetamol 500mg") — safe for JSS-SS
  // students, NOT safe for younger children once Nursery/Primary are added.
  // Cross-check against this table (mg/kg) before dosing anyone under ~12
  // years or ~30kg.
  var PEDIATRIC_DOSING = [
    {drug:"Paracetamol", dose:"15mg/kg per dose, every 4-6 hours (max 4 doses/day)", note:"Use paediatric syrup, not adult tablets, under ~12 years/30kg"},
    {drug:"Ibuprofen", dose:"5-10mg/kg per dose, every 6-8 hours with food", note:"Avoid if dehydrated or asthma history"},
    {drug:"Amoxicillin", dose:"25mg/kg per dose, every 8 hours", note:"Use paediatric suspension"},
    {drug:"Artemether-Lumefantrine (Coartem)", dose:"5-<15kg: 1 tab/dose · 15-<25kg: 2 tabs/dose · 25-<35kg: 3 tabs/dose · ≥35kg: 4 tabs/dose — all BD × 3 days", note:"Give with fatty food/milk for absorption"},
    {drug:"Metronidazole", dose:"7.5mg/kg per dose, every 8 hours", note:"—"},
    {drug:"Ciprofloxacin", dose:"10-15mg/kg per dose, every 12 hours", note:"Use with caution in young children — prefer hospital guidance"},
    {drug:"Cotrimoxazole", dose:"4mg/kg (trimethoprim component), every 12 hours", note:"—"},
    {drug:"ORS", dose:"50-100ml/kg over 4 hours (mild-moderate dehydration), then 10ml/kg per loose stool", note:"Small frequent sips"},
    {drug:"Zinc", dose:"<6 months: 10mg/day · ≥6 months: 20mg/day, for 10-14 days", note:"For diarrhoea management"},
    {drug:"Chlorphenamine (Piriton)", dose:"1-6 years: 1mg BD · 6-12 years: 2mg BD-TDS", note:"Sedating — advise caution"},
    {drug:"Salbutamol (nebulized)", dose:"<5 years: 2.5mg/nebule · ≥5 years: 5mg/nebule", note:"Use spacer/mask if nebulizer unavailable"},
    {drug:"Diazepam (seizure emergency)", dose:"Rectal 0.5mg/kg, or IV 0.3mg/kg slowly", note:"Emergency use only — monitor breathing"},
    {drug:"Adrenaline (anaphylaxis emergency)", dose:"IM 0.01mg/kg of 1:1000 (max 0.3mg), repeat every 5-15 min if needed", note:"Do not delay if anaphylaxis suspected"},
    {drug:"IV fluids (Normal Saline / Ringer's Lactate)", dose:"Bolus 10-20ml/kg over 15-30 min, reassess before repeating", note:"Use smaller boluses with caution in malnourished children"},
    {drug:"Dextrose (hypoglycaemia emergency)", dose:"IV 2-5ml/kg of 10% Dextrose, given slowly", note:"Recheck blood glucose 15 min after"},
  ];

  var DISPOSITIONS = [
    "Returned to class","Sent home","Referred to hospital",
    "Admitted to sick bay","Resting in clinic","Parent notified — monitoring"
  ];

  // Check all required fields filled
  var formComplete = foundPatient &&
    form.presentingConditions.length > 0 &&
    form.diagnosis.trim() &&
    form.treatmentPlan.trim() &&
    form.disposition;

  function toggleSymptom(sym){
    setForm(function(p){
      var exists = p.presentingConditions.indexOf(sym) >= 0;
      return {...p, presentingConditions: exists
        ? p.presentingConditions.filter(function(s){return s!==sym;})
        : [...p.presentingConditions, sym]
      };
    });
  }

  function applyCombo(combo){
    setForm(function(p){
      var newMeds = combo.drugs.map(function(d){
        var parts = d.split(" — ");
        return {id:genId(), drug:parts[0]||d, dose:"", frequency:parts[1]||"", duration:""};
      });
      return {...p, medications:[...p.medications,...newMeds], drugCombination:combo.name};
    });
  }

  function addMedication(){
    if(!newMed.drug.trim()) return;
    setForm(function(p){return{...p,medications:[...p.medications,{...newMed,id:genId()}]};});
    setNewMed({drug:"",dose:"",frequency:"",duration:""});
  }

  function removeMed(id){
    setForm(function(p){return{...p,medications:p.medications.filter(function(m){return m.id!==id;})};});
  }

  function saveConsultation(){
    if(!formComplete){ alert("Please complete all required fields before saving."); return; }
    if(!foundPatient){ alert("Please select a patient first."); return; }
    setSaving(true);
    var conditionText = (form.presentingConditions||[]).join(", ")+(form.otherCondition?", "+form.otherCondition:"");
    var isStaffPatient = patientType==="Staff";
    var record = {
      id:genId(),
      patientType: patientType,
      studentId: isStaffPatient ? null : foundPatient.id,
      staffId: isStaffPatient ? foundPatient.id : null,
      admissionNo: isStaffPatient ? ("Staff ID: "+foundPatient.id) : foundPatient.admissionNo,
      studentName: foundPatient.surname+" "+foundPatient.firstname,
      class: isStaffPatient ? ("Staff — "+(foundPatient.role||"Staff")) : foundPatient.class+(foundPatient.arm||""),
      date:today(), time:visitTime,
      presentingCondition:conditionText,
      vitalSigns:form.vitalSigns,
      diagnosis:form.diagnosis,
      treatmentPlan:form.treatmentPlan,
      treatmentPractice:form.treatmentPractice,
      emergencyProtocol:form.emergencyProtocol,
      medications:form.medications,
      drugCombination:form.drugCombination,
      nurseName:form.nurseName||currentUser.name,
      disposition:form.disposition,
      followUp:form.followUp,
      notes:form.notes,
      session:CURRENT_SESSION,
      term:CURRENT_TERM,
    };
    setClinic(function(p){return[record,...p];});
    // SMS parent (student) or staff member directly (staff patient)
    var notifyPhone = isStaffPatient ? foundPatient.phone : foundPatient.parentPhone;
    if(notifyPhone){
      var msg = isStaffPatient
        ? ("Dear "+foundPatient.firstname+", you visited the school clinic today ("+today()+"). Condition: "+conditionText.slice(0,60)+". Disposition: "+form.disposition+". — "+SCHOOL_NAME)
        : ("Dear Parent, "+foundPatient.firstname+" "+foundPatient.surname+" visited the school clinic today ("+today()+"). Condition: "+conditionText.slice(0,60)+". Disposition: "+form.disposition+". — "+SCHOOL_NAME);
      sendSMS(notifyPhone, msg, "Clinic Notification");
    }
    setSaving(false); setSaved(true);
    setTimeout(function(){setSaved(false);setSelStudentId("");setSelStaffId("");setForm(emptyForm);setVisitTime(new Date().toLocaleTimeString("en-NG",{hour:"2-digit",minute:"2-digit"}));},3000);
  }

  // ── Records filtering ──────────────────────────────────
  var records = clinic.filter(function(r){
    var matchSearch = !search || (r.studentName+r.admissionNo+r.class+r.presentingCondition+r.diagnosis).toLowerCase().includes(search.toLowerCase());
    var matchDate = !filterDate || r.date===filterDate;
    return matchSearch && matchDate;
  }).sort(function(a,b){return b.date===a.date?b.time.localeCompare(a.time):b.date.localeCompare(a.date);});

  var todayRecords = clinic.filter(function(r){return r.date===today();});
  var sickBay = clinic.filter(function(r){return r.disposition==="Admitted to sick bay";});
  var thisTermVisits = clinic.filter(function(r){return r.session===CURRENT_SESSION&&r.term===CURRENT_TERM;}).length;
  var visitMap = {};
  clinic.forEach(function(r){var pid=recordPatientId(r); if(pid) visitMap[pid]=(visitMap[pid]||0)+1;});
  var frequent = Object.entries(visitMap).sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){
    var s=students.find(function(st){return st.id===e[0];});
    if(s) return{name:s.surname+" "+s.firstname,count:e[1],class:s.class+(s.arm||""),id:e[0]};
    var stf=staff.find(function(x){return x.id===e[0];});
    if(stf) return{name:stf.surname+" "+stf.firstname,count:e[1],class:"Staff — "+(stf.role||""),id:e[0]};
    return{name:"Unknown",count:e[1],class:"",id:e[0]};
  });
  var condMapObj={};
  clinic.filter(function(r){return r.session===CURRENT_SESSION&&r.term===CURRENT_TERM;}).forEach(function(r){
    var cond=(r.presentingCondition||"").split(",")[0].trim();
    if(cond)condMapObj[cond]=(condMapObj[cond]||0)+1;
  });
  var conditionStats=Object.entries(condMapObj).sort(function(a,b){return b[1]-a[1];}).slice(0,10);

  // ── Full medical history lookup (any student or staff) ──
  var historyParts = historySel.split(":");
  var historyType = historyParts[0]==="staff" ? "Staff" : historyParts[0]==="student" ? "Student" : null;
  var historyPatient = historyType==="Staff" ? staff.find(function(s){return s.id===historyParts[1];}) : historyType==="Student" ? students.find(function(s){return s.id===historyParts[1];}) : null;
  var historyRecords = historyPatient ? clinic.filter(function(r){return recordPatientId(r)===historyPatient.id;}).sort(function(a,b){return a.date===b.date?a.time.localeCompare(b.time):a.date.localeCompare(b.date);}) : [];

  function buildMedicalHistoryHtml(patient, type, patientRecords){
    var hdr = buildDocHeader(settings, (type==="Staff"?"STAFF":"STUDENT")+" MEDICAL HISTORY");
    var idBlock = type==="Staff"
      ? '<div class="info-row"><b>Name:</b> '+patient.surname+' '+patient.firstname+'</div><div class="info-row"><b>Role:</b> '+(patient.role||"Staff")+'</div><div class="info-row"><b>Gender:</b> '+(patient.gender||"—")+'</div><div class="info-row"><b>D.O.B:</b> '+(patient.dob?formatDate(patient.dob):"—")+'</div><div class="info-row"><b>Phone:</b> '+(patient.phone||"—")+'</div><div class="info-row"><b>Next of Kin:</b> '+(patient.nextOfKin||"—")+' ('+(patient.nextOfKinPhone||"—")+')</div>'
      : '<div class="info-row"><b>Name:</b> '+patient.surname+' '+patient.firstname+'</div><div class="info-row"><b>Admission No.:</b> '+patient.admissionNo+'</div><div class="info-row"><b>Class:</b> '+patient.class+(patient.arm||"")+'</div><div class="info-row"><b>D.O.B:</b> '+(patient.dob?formatDate(patient.dob):"—")+'</div><div class="info-row"><b>Gender:</b> '+(patient.gender||"—")+'</div><div class="info-row"><b>Blood Group:</b> '+(patient.bloodGroup||"—")+' &nbsp;·&nbsp; <b>Genotype:</b> '+(patient.genotype||"—")+'</div><div class="info-row"><b>Parent/Guardian:</b> '+(patient.parentName||"—")+' ('+(patient.parentPhone||"—")+')</div>';

    var rows = patientRecords.map(function(r){
      var meds = (r.medications||[]).map(function(m){return m.drug;}).join(", ")||"—";
      return '<tr><td>'+formatDate(r.date)+' '+r.time+'</td><td>'+r.presentingCondition+'</td><td>'+r.diagnosis+'</td><td style="white-space:pre-line;">'+(r.treatmentPlan||"—")+'</td><td>'+meds+'</td><td>'+r.disposition+'</td></tr>';
    }).join("");

    return '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Medical History</title><style>'+hdr.printStyles+
      'table{width:100%;border-collapse:collapse;margin-top:10px;}th,td{border:1px solid #ccc;padding:6px;font-size:10px;text-align:left;vertical-align:top;}th{background:#8B0000;color:#fff;}'+
      '.info-row{font-size:11px;margin-bottom:3px;}</style></head><body>'+
      hdr.headerHtml+
      '<h3 style="text-align:center;color:#8B0000;">'+(type==="Staff"?"STAFF":"STUDENT")+' MEDICAL HISTORY — CONFIDENTIAL</h3>'+
      '<div style="border:1px solid #ccc;padding:10px;margin-bottom:10px;">'+idBlock+'</div>'+
      '<div style="margin-bottom:8px;font-size:11px;"><b>Total clinic visits:</b> '+patientRecords.length+' &nbsp;|&nbsp; <b>Period covered:</b> '+(patientRecords.length?formatDate(patientRecords[0].date)+' to '+formatDate(patientRecords[patientRecords.length-1].date):"—")+'</div>'+
      '<table><thead><tr><th>Date/Time</th><th>Presenting Condition</th><th>Diagnosis</th><th>Treatment Plan</th><th>Medications</th><th>Disposition</th></tr></thead><tbody>'+
      (rows||'<tr><td colspan="6" style="text-align:center;color:#999;">No clinic visits recorded.</td></tr>')+
      '</tbody></table>'+
      '<div style="margin-top:16px;font-size:9px;color:#666;">This document is prepared for referral or record-keeping purposes and contains confidential health information. Handle in accordance with the school\'s data protection policy.</div>'+
      hdr.footerHtml+'</body></html>';
  }

  // ── Drug intake report (day / week / month / term) ──
  function isInDrugPeriod(r){
    if(drugPeriod==="term") return r.session===CURRENT_SESSION && r.term===CURRENT_TERM;
    if(drugPeriod==="day") return r.date===drugRefDate;
    if(drugPeriod==="week"){
      var ref = new Date(drugRefDate);
      var day = ref.getDay();
      var diffToMon = (day===0?-6:1-day);
      var monday = new Date(ref); monday.setDate(ref.getDate()+diffToMon); monday.setHours(0,0,0,0);
      var sunday = new Date(monday); sunday.setDate(monday.getDate()+6); sunday.setHours(23,59,59,999);
      var rd = new Date(r.date);
      return rd>=monday && rd<=sunday;
    }
    if(drugPeriod==="month") return r.date.slice(0,7)===drugRefDate.slice(0,7);
    return true;
  }
  var drugFreqMap={};
  clinic.filter(isInDrugPeriod).forEach(function(r){
    (r.medications||[]).forEach(function(m){
      if(!m.drug) return;
      drugFreqMap[m.drug]=(drugFreqMap[m.drug]||0)+1;
    });
  });
  var drugStats = Object.entries(drugFreqMap).sort(function(a,b){return b[1]-a[1];});
  var drugPeriodLabel = drugPeriod==="term" ? (CURRENT_TERM+" "+CURRENT_SESSION)
    : drugPeriod==="day" ? formatDate(drugRefDate)
    : drugPeriod==="week" ? ("Week containing "+formatDate(drugRefDate))
    : ("Month of "+formatDate(drugRefDate));

  return(
    <div>
      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border,flexWrap:"wrap"}}>
        {[["present","🩺 New Patient"],["daily","📋 Today's Patients"],["records","🗂 All Records"],["sickbay","🛏 Sick Bay"],["stats","📊 Statistics"]].map(function(pair){
          return <button key={pair[0]} onClick={function(){setTab(pair[0]);setViewing(null);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 12px"}}>{pair[1]}{pair[0]==="daily"?<span style={{background:"#DC2626",color:"#fff",borderRadius:"50%",fontSize:9,padding:"0 4px",marginLeft:4}}>{todayRecords.length}</span>:null}</button>;
        })}
      </div>

      {/* ── TAB: NEW PATIENT ── */}
      {tab==="present" ? (
        <div>
          {saved ? (
            <div style={{...S.card,background:"#D1FAE5",border:"2px solid #059669",textAlign:"center",padding:32}}>
              <div style={{fontSize:32,marginBottom:8}}>✅</div>
              <div style={{fontSize:15,fontWeight:700,color:"#065F46"}}>Consultation saved! Parent notified via SMS.</div>
              <div style={{fontSize:12,color:"#047857",marginTop:4}}>Form will reset in a moment...</div>
            </div>
          ) : (
            <div>
              {/* STEP 1 — Patient Type → Class/Student or Staff → Time */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #DC2626"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#DC2626",marginBottom:12}}>STEP 1 — Select Patient</div>
                <div style={{...S.row,gap:8,marginBottom:12}}>
                  {["Student","Staff"].map(function(t){
                    return <button key={t} type="button" onClick={function(){setPatientType(t);setSelStudentId("");setSelStaffId("");}} style={{...S.btn(patientType===t?"primary":"secondary"),fontSize:11}}>{t==="Student"?"🎓 Student":"👤 Staff"}</button>;
                  })}
                </div>
                {patientType==="Student"?(
                  <div style={{display:"grid",gridTemplateColumns:"1fr 2fr 1fr",gap:10,alignItems:"end"}}>
                    <div style={S.formGroup}>
                      <label style={S.label}>Class *</label>
                      <select style={{...S.select,width:"100%"}} value={selClass} onChange={function(e){setSelClass(e.target.value);setSelStudentId("");}}>
                        {CLASSES.map(function(c){return <option key={c}>{c}</option>;})}
                      </select>
                    </div>
                    <div style={S.formGroup}>
                      <label style={S.label}>Student Name *</label>
                      <select style={{...S.select,width:"100%"}} value={selStudentId} onChange={function(e){setSelStudentId(e.target.value);}}>
                        <option value="">— Select Student —</option>
                        {classStudents.map(function(s){return <option key={s.id} value={s.id}>{s.surname} {s.firstname} {s.middlename||""}</option>;})}
                      </select>
                    </div>
                    <div style={S.formGroup}>
                      <label style={S.label}>Time of Visit</label>
                      <input style={S.input} value={visitTime} onChange={function(e){setVisitTime(e.target.value);}} placeholder="HH:MM"/>
                    </div>
                  </div>
                ):(
                  <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10,alignItems:"end"}}>
                    <div style={S.formGroup}>
                      <label style={S.label}>Staff Name *</label>
                      <select style={{...S.select,width:"100%"}} value={selStaffId} onChange={function(e){setSelStaffId(e.target.value);}}>
                        <option value="">— Select Staff —</option>
                        {activeStaff.map(function(s){return <option key={s.id} value={s.id}>{s.surname} {s.firstname} ({s.role||"Staff"})</option>;})}
                      </select>
                    </div>
                    <div style={S.formGroup}>
                      <label style={S.label}>Time of Visit</label>
                      <input style={S.input} value={visitTime} onChange={function(e){setVisitTime(e.target.value);}} placeholder="HH:MM"/>
                    </div>
                  </div>
                )}

                {/* Patient biodata display */}
                {foundPatient ? (
                  <div style={{marginTop:12,background:"linear-gradient(120deg,#230E6A,#3D2496)",borderRadius:10,padding:"14px 18px",color:"#fff"}}>
                    <div style={{fontSize:10,opacity:0.7,fontWeight:600,marginBottom:8}}>PATIENT BIODATA</div>
                    <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                      <div style={{width:54,height:54,borderRadius:"50%",overflow:"hidden",border:"2px solid #F0C060",flexShrink:0,background:"rgba(255,255,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        {foundPatient.passport?<img src={foundPatient.passport} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:22}}>👤</span>}
                      </div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:15,fontWeight:900,color:"#F0C060"}}>{foundPatient.surname} {foundPatient.firstname} {foundPatient.middlename||""}</div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:4,marginTop:8}}>
                          {(patientType==="Student"
                            ? [["Admission No.",foundPatient.admissionNo],["Class",foundPatient.class+(foundPatient.arm||"")],["Gender",foundPatient.gender],["D.O.B",formatDate(foundPatient.dob)],["Blood Group",foundPatient.bloodGroup||"—"],["Genotype",foundPatient.genotype||"—"],["Boarding",foundPatient.boardingType||"Day"],["Parent Phone",foundPatient.parentPhone||"—"],["Religion",foundPatient.religion||"—"]]
                            : [["Role",foundPatient.role||"Staff"],["Gender",foundPatient.gender],["D.O.B",formatDate(foundPatient.dob)],["Phone",foundPatient.phone||"—"],["Qualification",foundPatient.qualification||"—"],["Classes Taught",(foundPatient.classes||[]).join(", ")||"—"],["Next of Kin",foundPatient.nextOfKin||"—"],["Next of Kin Phone",foundPatient.nextOfKinPhone||"—"]]
                          ).map(function(pair){
                            return <div key={pair[0]}><div style={{fontSize:8,opacity:0.6,fontWeight:600}}>{pair[0]}</div><div style={{fontSize:10,fontWeight:700}}>{pair[1]}</div></div>;
                          })}
                        </div>
                      </div>
                    </div>
                    {clinic.filter(function(r){return recordPatientId(r)===foundPatient.id;}).length>0?(
                      <div style={{marginTop:10,background:"rgba(255,255,255,0.1)",borderRadius:6,padding:"8px 12px"}}>
                        <div style={{fontSize:9,opacity:0.7,marginBottom:4}}>PREVIOUS VISITS ({clinic.filter(function(r){return recordPatientId(r)===foundPatient.id;}).length} total)</div>
                        {clinic.filter(function(r){return recordPatientId(r)===foundPatient.id;}).slice(0,2).map(function(r,i){return <div key={i} style={{fontSize:9,opacity:0.85}}>{r.date} — {r.presentingCondition.slice(0,50)} → {r.diagnosis.slice(0,40)}</div>;})}
                      </div>
                    ):null}
                  </div>
                ) : (
                  <div style={{marginTop:10,background:"#F9FAFB",borderRadius:8,padding:16,textAlign:"center",color:C.textMuted,fontSize:12}}>Select a {patientType.toLowerCase()} above to see their biodata</div>
                )}
              </div>

              {/* STEP 2 — Vital Signs */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #D97706"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#D97706",marginBottom:12}}>STEP 2 — Vital Signs</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10}}>
                  {[["🌡 Temperature","temperature","e.g. 37.5°C"],["💓 Pulse (bpm)","pulse","e.g. 80bpm"],["🩺 Blood Pressure","bp","e.g. 120/80mmHg"],["⚖ Weight (kg)","weight","e.g. 50kg"],["📏 Height (cm)","height","e.g. 155cm"]].map(function(f){
                    return(
                      <div key={f[1]} style={S.formGroup}>
                        <label style={S.label}>{f[0]}</label>
                        <input style={S.input} placeholder={f[2]} value={form.vitalSigns[f[1]]||""} onChange={function(e){var val=e.target.value;setForm(function(p){return{...p,vitalSigns:{...p.vitalSigns,[f[1]]:val}};});}}/>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* STEP 3 — Presenting Conditions (multi-select) */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #DC2626"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#DC2626",marginBottom:4}}>STEP 3 — Presenting Condition * <span style={{fontSize:10,fontWeight:400,color:C.textMuted}}>(select one or more)</span></div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
                  {SYMPTOMS.map(function(sym){
                    var selected = form.presentingConditions.indexOf(sym)>=0;
                    return(
                      <button key={sym} type="button" onClick={function(){toggleSymptom(sym);}} style={{
                        padding:"4px 10px",borderRadius:16,fontSize:10,fontWeight:600,cursor:"pointer",border:"1px solid",
                        background:selected?"#DC2626":"#fff",color:selected?"#fff":"#374151",
                        borderColor:selected?"#DC2626":"#D1D5DB"
                      }}>{selected?"✓ ":""}{sym}</button>
                    );
                  })}
                </div>
                {form.presentingConditions.indexOf("Others")>=0?(
                  <div style={S.formGroup}>
                    <label style={S.label}>Specify other condition</label>
                    <input style={S.input} value={form.otherCondition} onChange={function(e){setForm(function(p){return{...p,otherCondition:e.target.value};});}} placeholder="Describe the condition..."/>
                  </div>
                ):null}
                {form.presentingConditions.length>0?(
                  <div style={{fontSize:11,color:"#DC2626",fontWeight:600,marginTop:6}}>Selected: {form.presentingConditions.join(", ")}{form.otherCondition?", "+form.otherCondition:""}</div>
                ):null}
              </div>

              {/* STEP 4 — Diagnosis */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #230E6A"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#230E6A",marginBottom:10}}>STEP 4 — Diagnosis *</div>
                <input style={S.input} value={form.diagnosis} onChange={function(e){setForm(function(p){return{...p,diagnosis:e.target.value};});}} placeholder="e.g. Malaria, Viral fever, Gastroenteritis, Urinary tract infection..."/>
              </div>

              {/* STEP 5 — Treatment Plan + Best Practices */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #059669"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#059669",marginBottom:10}}>STEP 5 — Treatment Plan *</div>

                {/* Best practice selector */}
                <div style={{marginBottom:10}}>
                  <label style={S.label}>Load Best Practice Template (Nigerian PHC)</label>
                  <select style={{...S.select,width:"100%"}} value="" onChange={function(e){
                    if(e.target.value&&TREATMENT_PRACTICES[e.target.value]){
                      setForm(function(p){return{...p,treatmentPractice:TREATMENT_PRACTICES[e.target.value],treatmentPlan:TREATMENT_PRACTICES[e.target.value]};});
                    }
                  }}>
                    <option value="">— Select a condition to load standard treatment —</option>
                    {Object.keys(TREATMENT_PRACTICES).map(function(k){return <option key={k} value={k}>{k}</option>;})}
                  </select>
                </div>
                <textarea style={{...S.textarea,minHeight:90}} value={form.treatmentPlan} onChange={function(e){setForm(function(p){return{...p,treatmentPlan:e.target.value};});}} placeholder="Outline the full treatment plan..."/>
              </div>

              {/* STEP 5b — Emergency / Admission Protocol */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #B91C1C",background:"#FEF2F2"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#B91C1C",marginBottom:4}}>⚠ Emergency / Admission Protocol (if condition escalates)</div>
                <div style={{fontSize:10,color:C.textMuted,marginBottom:10}}>Load this if the patient needs to be admitted to sick bay or referred — includes stabilization steps, drug combinations, and IV infusion guidance.</div>
                <div style={{marginBottom:10}}>
                  <select style={{...S.select,width:"100%"}} value="" onChange={function(e){
                    if(e.target.value&&EMERGENCY_PROTOCOLS[e.target.value]){
                      setForm(function(p){return{...p,emergencyProtocol:EMERGENCY_PROTOCOLS[e.target.value]};});
                    }
                  }}>
                    <option value="">— Select a condition to load emergency protocol —</option>
                    {Object.keys(EMERGENCY_PROTOCOLS).map(function(k){return <option key={k} value={k}>{k}</option>;})}
                  </select>
                </div>
                {form.emergencyProtocol?(
                  <div>
                    <textarea style={{...S.textarea,minHeight:110,borderColor:"#B91C1C",whiteSpace:"pre-line"}} value={form.emergencyProtocol} onChange={function(e){setForm(function(p){return{...p,emergencyProtocol:e.target.value};});}}/>
                    <button type="button" style={{...S.btn("secondary"),fontSize:10,marginTop:6}} onClick={function(){setForm(function(p){return{...p,emergencyProtocol:""};});}}>Clear</button>
                  </div>
                ):null}
              </div>

              {/* STEP 6 — Medications with combinations */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #6B491B"}}>
                <div style={{...S.row,justifyContent:"space-between",marginBottom:10}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#6B491B"}}>STEP 6 — Medications Dispensed</div>
                  <button type="button" style={{...S.btn(showPedDosing?"primary":"secondary"),fontSize:10,padding:"4px 10px"}} onClick={function(){setShowPedDosing(function(p){return !p;});}}>👶 {showPedDosing?"Hide":"Show"} Pediatric Dosing Reference</button>
                </div>
                {showPedDosing?(
                  <div style={{...S.card,background:"#EFF6FF",border:"1px solid #93C5FD",marginBottom:12}}>
                    <div style={{fontSize:10,color:"#1D4ED8",marginBottom:8}}>⚠ All doses in the Best Practice / Emergency Protocol templates above are adolescent/adult doses (safe for JSS-SS students). For any child under ~12 years or ~30kg, use weight-based dosing below instead.</div>
                    <table style={S.table}><thead><tr>{["Drug","Weight/Age-Based Dose","Note"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
                      <tbody>{PEDIATRIC_DOSING.map(function(p,i){return <tr key={i}><td style={{...S.td,fontWeight:600}}>{p.drug}</td><td style={S.td}>{p.dose}</td><td style={{...S.td,fontSize:10,color:C.textMuted}}>{p.note}</td></tr>;})}</tbody>
                    </table>
                  </div>
                ):null}

                {/* Drug combination presets */}
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:600,color:C.textMuted,marginBottom:6}}>💊 Load Drug Combination:</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {DRUG_COMBOS.map(function(combo){
                      return <button key={combo.name} type="button" onClick={function(){applyCombo(combo);}} style={{...S.badge("green"),cursor:"pointer",border:"1px solid #059669",padding:"4px 10px",fontSize:10,fontWeight:600}}>{combo.name}</button>;
                    })}
                  </div>
                </div>

                {/* Individual drug quick-select */}
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:600,color:C.textMuted,marginBottom:6}}>Or add individual drugs:</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                    {COMMON_DRUGS.map(function(d){return <button key={d} type="button" onClick={function(){setNewMed(function(p){return{...p,drug:d};});}} style={{...S.badge("blue"),cursor:"pointer",border:"1px solid #1D4ED8",fontSize:9,padding:"2px 7px"}}>{d}</button>;})}
                  </div>
                </div>

                {/* Manual drug entry */}
                <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr auto",gap:6,alignItems:"end",marginBottom:10}}>
                  <div style={S.formGroup}><label style={S.label}>Drug</label><input style={S.input} value={newMed.drug} onChange={function(e){setNewMed(function(p){return{...p,drug:e.target.value};});}} placeholder="Drug name"/></div>
                  <div style={S.formGroup}><label style={S.label}>Dose</label><input style={S.input} value={newMed.dose} onChange={function(e){setNewMed(function(p){return{...p,dose:e.target.value};});}} placeholder="e.g. 1 tab"/></div>
                  <div style={S.formGroup}><label style={S.label}>Frequency</label><input style={S.input} value={newMed.frequency} onChange={function(e){setNewMed(function(p){return{...p,frequency:e.target.value};});}} placeholder="e.g. TDS"/></div>
                  <div style={S.formGroup}><label style={S.label}>Duration</label><input style={S.input} value={newMed.duration} onChange={function(e){setNewMed(function(p){return{...p,duration:e.target.value};});}} placeholder="3 days"/></div>
                  <button style={{...S.btn("blue"),marginBottom:2}} onClick={addMedication}>+ Add</button>
                </div>

                {form.medications.length>0?(
                  <table style={S.table}>
                    <thead><tr>{["Drug","Dose","Frequency","Duration",""].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
                    <tbody>
                      {form.medications.map(function(m){return(
                        <tr key={m.id}>
                          <td style={{...S.td,fontWeight:600}}>{m.drug}</td>
                          <td style={S.td}>{m.dose}</td>
                          <td style={S.td}>{m.frequency}</td>
                          <td style={S.td}>{m.duration}</td>
                          <td style={S.td}><button onClick={function(){removeMed(m.id);}} style={{...S.btn("danger"),fontSize:10,padding:"2px 8px"}}>Remove</button></td>
                        </tr>
                      );})}
                    </tbody>
                  </table>
                ):(
                  <div style={{textAlign:"center",color:C.textMuted,fontSize:11,padding:12}}>No medications added yet. Use the combination presets or add individually above.</div>
                )}
              </div>

              {/* STEP 7 — Disposition & Follow-up */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #7C3AED"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#7C3AED",marginBottom:10}}>STEP 7 — Disposition & Follow-up *</div>
                <div style={S.grid3}>
                  <div style={S.formGroup}>
                    <label style={S.label}>Disposition *</label>
                    <select style={{...S.select,width:"100%"}} value={form.disposition} onChange={function(e){setForm(function(p){return{...p,disposition:e.target.value};});}}>
                      {DISPOSITIONS.map(function(d){return <option key={d}>{d}</option>;})}
                    </select>
                  </div>
                  <div style={S.formGroup}>
                    <label style={S.label}>Follow-up Date</label>
                    <input style={S.input} type="date" value={form.followUp} onChange={function(e){setForm(function(p){return{...p,followUp:e.target.value};});}}/>
                  </div>
                  <div style={S.formGroup}>
                    <label style={S.label}>Attending Nurse / Staff</label>
                    <input style={S.input} value={form.nurseName} onChange={function(e){setForm(function(p){return{...p,nurseName:e.target.value};});}}/>
                  </div>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Additional Notes</label>
                  <textarea style={{...S.textarea,minHeight:60}} value={form.notes} onChange={function(e){setForm(function(p){return{...p,notes:e.target.value};});}} placeholder="Any additional observations, parent contact, referral details..."/>
                </div>
              </div>

              {/* Submit */}
              <div style={{...S.card,background:formComplete?"#F0FDF4":"#F9FAFB",border:"1px solid "+(formComplete?"#BBF7D0":"#E5E7EB")}}>
                {!formComplete?(
                  <div style={{fontSize:12,color:C.danger,marginBottom:10}}>
                    ⚠️ Required before saving:
                    {!foundPatient?" · Select patient":""}{form.presentingConditions.length===0?" · Choose presenting condition":""}{!form.diagnosis.trim()?" · Enter diagnosis":""}{!form.treatmentPlan.trim()?" · Enter treatment plan":""}
                  </div>
                ):(
                  <div style={{fontSize:12,color:C.success,marginBottom:10,fontWeight:600}}>✅ All required fields complete. Ready to save.</div>
                )}
                <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
                  <button style={S.btn("secondary")} onClick={function(){setSelStudentId("");setForm(emptyForm);}}>Clear Form</button>
                  <button style={{...S.btn(),padding:"10px 28px",fontSize:13,opacity:(formComplete&&!saving)?1:0.5}} onClick={saveConsultation} disabled={!formComplete||saving}>
                    {saving?"⏳ Saving...":"💾 Save Consultation & Notify Parent"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* ── TAB: TODAY'S PATIENTS ── */}
      {tab==="daily" ? (
        <div>
          <div style={{...S.card,background:"#FEF2F2",border:"1px solid #FECACA",marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:700,color:"#DC2626"}}>📋 Today's Clinic — {formatDate(today())}</div>
            <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{todayRecords.length} patient{todayRecords.length!==1?"s":""} seen today</div>
          </div>
          {todayRecords.length===0?(
            <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
              <div style={{fontSize:32,marginBottom:8}}>🏥</div>
              <div style={{fontSize:13,fontWeight:600}}>No patients seen today yet</div>
            </div>
          ):todayRecords.map(function(r){
            return(
              <div key={r.id} style={{...S.card,marginBottom:10,borderLeft:"3px solid #DC2626",cursor:"pointer"}} onClick={function(){setViewing(r);setTab("records");}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{...S.row,gap:8,marginBottom:4}}>
                      <span style={{fontSize:13,fontWeight:700,color:"#230E6A"}}>{r.studentName}</span>
                      <span style={S.badge("blue")}>{r.class}</span>
                      <span style={{fontSize:11,color:C.textMuted}}>{r.time}</span>
                    </div>
                    <div style={{fontSize:12,marginBottom:2}}><b>Presenting:</b> {r.presentingCondition}</div>
                    <div style={{fontSize:12}}><b>Diagnosis:</b> {r.diagnosis}</div>
                    {r.medications&&r.medications.length>0?<div style={{fontSize:11,color:C.textMuted,marginTop:3}}>💊 {r.medications.map(function(m){return m.drug;}).join(", ")}</div>:null}
                  </div>
                  <span style={S.badge(r.disposition==="Returned to class"?"green":r.disposition==="Referred to hospital"?"red":"yellow")}>{r.disposition}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* ── TAB: ALL RECORDS ── */}
      {tab==="records" ? (
        <div>
          <div style={{...S.card,marginBottom:14}}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <input style={{...S.input,flex:1,minWidth:200}} placeholder="Search name, condition, diagnosis..." value={search} onChange={function(e){setSearch(e.target.value);}}/>
              <input style={S.input} type="date" value={filterDate} onChange={function(e){setFilterDate(e.target.value);}}/>
              {(search||filterDate)?<button style={{...S.btn("secondary"),fontSize:11}} onClick={function(){setSearch("");setFilterDate("");}}>Clear</button>:null}
            </div>
            <div style={{fontSize:11,color:C.textMuted,marginTop:6}}>{records.length} record{records.length!==1?"s":""} found</div>
          </div>

          <div style={{...S.card,marginBottom:14,background:"#F5F3FB"}}>
            <div style={S.cardTitle}>📁 Full Medical History Lookup</div>
            <div style={{fontSize:11,color:C.textMuted,marginBottom:8}}>Compile a patient's complete clinic history — ready to print, download or share for referrals.</div>
            <select style={{...S.select,width:"100%"}} value={historySel} onChange={function(e){setHistorySel(e.target.value);}}>
              <option value="">— Select a student or staff member —</option>
              <optgroup label="Students">
                {students.slice().sort(function(a,b){return (a.surname+a.firstname).localeCompare(b.surname+b.firstname);}).map(function(s){return <option key={"student:"+s.id} value={"student:"+s.id}>{s.surname} {s.firstname} — {s.class}{s.arm}</option>;})}
              </optgroup>
              <optgroup label="Staff">
                {staff.slice().sort(function(a,b){return (a.surname+a.firstname).localeCompare(b.surname+b.firstname);}).map(function(s){return <option key={"staff:"+s.id} value={"staff:"+s.id}>{s.surname} {s.firstname} — {s.role||"Staff"}</option>;})}
              </optgroup>
            </select>
            {historyPatient?(
              <div style={{marginTop:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:8}}>
                  <div style={{fontSize:12,fontWeight:700}}>{historyRecords.length} visit{historyRecords.length!==1?"s":""} on record for {historyPatient.surname} {historyPatient.firstname}</div>
                  <DocActionBar getHtml={function(){return buildMedicalHistoryHtml(historyPatient, historyType, historyRecords);}} filename={"Medical_History_"+historyPatient.surname+"_"+historyPatient.firstname} title={"Medical History — "+historyPatient.surname+" "+historyPatient.firstname}/>
                </div>
                {historyRecords.length===0?<div style={{color:C.textMuted,fontSize:12}}>No clinic visits recorded yet.</div>:(
                  <div style={{maxHeight:240,overflowY:"auto"}}>
                    {historyRecords.slice().reverse().map(function(r,i){
                      return <div key={i} style={{fontSize:11,padding:"4px 0",borderBottom:"1px solid "+C.border}}>{formatDate(r.date)} — {r.presentingCondition} → {r.diagnosis}</div>;
                    })}
                  </div>
                )}
              </div>
            ):null}
          </div>

          {viewing?(
            <div style={S.card}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div style={{fontSize:14,fontWeight:700,color:"#DC2626"}}>Clinic Record — {viewing.studentName}</div>
                <button onClick={function(){setViewing(null);}} style={{...S.btn("secondary"),fontSize:11}}>← Back</button>
              </div>
              <div style={{background:"linear-gradient(120deg,#230E6A,#3D2496)",borderRadius:10,padding:"14px 18px",color:"#fff",marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                  <div><div style={{fontSize:16,fontWeight:800,color:"#F0C060"}}>{viewing.studentName}</div><div style={{fontSize:12,opacity:0.8}}>{viewing.class} · {viewing.admissionNo}</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:13,fontWeight:700}}>{viewing.date} · {viewing.time}</div><div style={{fontSize:11,opacity:0.8}}>Nurse: {viewing.nurseName}</div></div>
                </div>
              </div>
              {viewing.vitalSigns&&Object.values(viewing.vitalSigns).some(function(v){return v;})?(
                <div style={{...S.card,background:"#FEF2F2",marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#DC2626",marginBottom:8}}>VITAL SIGNS</div>
                  <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                    {[["🌡 Temp","temperature"],["💓 Pulse","pulse"],["🩺 BP","bp"],["⚖ Weight","weight"],["📏 Height","height"]].map(function(pair){return viewing.vitalSigns[pair[1]]?(<div key={pair[1]}><div style={{fontSize:9,color:C.textMuted}}>{pair[0]}</div><div style={{fontSize:13,fontWeight:700}}>{viewing.vitalSigns[pair[1]]}</div></div>):null;})}
                  </div>
                </div>
              ):null}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                <div style={S.card}><div style={{fontSize:10,fontWeight:700,color:"#DC2626",marginBottom:4}}>PRESENTING CONDITION</div><div style={{fontSize:13,lineHeight:1.6}}>{viewing.presentingCondition}</div></div>
                <div style={S.card}><div style={{fontSize:10,fontWeight:700,color:"#230E6A",marginBottom:4}}>DIAGNOSIS</div><div style={{fontSize:13,fontWeight:600}}>{viewing.diagnosis}</div></div>
              </div>
              {viewing.treatmentPlan?<div style={{...S.card,marginBottom:12}}><div style={{fontSize:10,fontWeight:700,color:"#059669",marginBottom:4}}>TREATMENT PLAN</div><div style={{fontSize:12,lineHeight:1.6,whiteSpace:"pre-line"}}>{viewing.treatmentPlan}</div></div>:null}
              {viewing.emergencyProtocol?<div style={{...S.card,marginBottom:12,background:"#FEF2F2",border:"1px solid #B91C1C"}}><div style={{fontSize:10,fontWeight:700,color:"#B91C1C",marginBottom:4}}>⚠ EMERGENCY / ADMISSION PROTOCOL USED</div><div style={{fontSize:12,lineHeight:1.6,whiteSpace:"pre-line"}}>{viewing.emergencyProtocol}</div></div>:null}
              {viewing.medications&&viewing.medications.length>0?(
                <div style={{...S.card,marginBottom:12}}>
                  <div style={{fontSize:10,fontWeight:700,color:"#6B491B",marginBottom:8}}>MEDICATIONS</div>
                  <table style={S.table}><thead><tr>{["Drug","Dose","Frequency","Duration"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
                  <tbody>{viewing.medications.map(function(m,i){return <tr key={i}><td style={{...S.td,fontWeight:600}}>{m.drug}</td><td style={S.td}>{m.dose}</td><td style={S.td}>{m.frequency}</td><td style={S.td}>{m.duration}</td></tr>;})}</tbody></table>
                </div>
              ):null}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div style={S.card}><div style={{fontSize:10,fontWeight:700,color:C.textMuted,marginBottom:4}}>DISPOSITION</div><span style={S.badge(viewing.disposition==="Returned to class"?"green":viewing.disposition==="Referred to hospital"?"red":"yellow")}>{viewing.disposition}</span></div>
                {viewing.followUp?<div style={S.card}><div style={{fontSize:10,fontWeight:700,color:C.textMuted,marginBottom:4}}>FOLLOW-UP</div><div style={{fontSize:13,fontWeight:700}}>{formatDate(viewing.followUp)}</div></div>:null}
              </div>
              {viewing.notes?<div style={{...S.card,marginTop:12}}><div style={{fontSize:10,fontWeight:700,color:C.textMuted,marginBottom:4}}>NOTES</div><div style={{fontSize:12}}>{viewing.notes}</div></div>:null}
            </div>
          ):(
            records.length===0?<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}><div style={{fontSize:36,marginBottom:8}}>🏥</div><div>No records found.</div></div>:
            records.map(function(r){return(
              <div key={r.id} style={{...S.card,marginBottom:10,cursor:"pointer"}} onClick={function(){setViewing(r);}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
                  <div style={{flex:1}}>
                    <div style={{...S.row,gap:8,marginBottom:4}}><span style={{fontSize:13,fontWeight:700,color:"#230E6A"}}>{r.studentName}</span>{r.patientType==="Staff"&&<span style={S.badge("gold")}>👤 Staff</span>}<span style={S.badge("blue")}>{r.class}</span><span style={S.badge(r.disposition==="Returned to class"?"green":r.disposition==="Referred to hospital"?"red":"yellow")}>{r.disposition}</span></div>
                    <div style={{fontSize:12,marginBottom:2}}><b>Presenting:</b> {r.presentingCondition}</div>
                    <div style={{fontSize:12}}><b>Diagnosis:</b> {r.diagnosis}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}><div style={{fontSize:12,fontWeight:700,color:"#DC2626"}}>{formatDate(r.date)}</div><div style={{fontSize:11,color:C.textMuted}}>{r.time}</div></div>
                </div>
              </div>
            );}
          ))}
        </div>
      ) : null}

      {/* ── TAB: SICK BAY ── */}
      {tab==="sickbay" ? (
        <div>
          <div style={{...S.card,background:"#FEF2F2",border:"1px solid #FECACA",marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:700,color:"#DC2626"}}>🛏 Current Sick Bay Occupants — {sickBay.length} student{sickBay.length!==1?"s":""}</div>
          </div>
          {sickBay.length===0?<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}><div style={{fontSize:32,marginBottom:8}}>✅</div><div style={{fontSize:13,fontWeight:600}}>Sick bay is currently empty</div></div>:
          sickBay.map(function(r){
            var stu=students.find(function(s){return s.id===r.studentId;});
            var daysIn=Math.floor((new Date()-new Date(r.date+"T00:00:00"))/(1000*60*60*24));
            return(
              <div key={r.id} style={{...S.card,marginBottom:10,borderLeft:"4px solid #DC2626"}}>
                <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                  <div style={{width:44,height:44,borderRadius:"50%",overflow:"hidden",background:"#F3F4F6",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                    {stu&&stu.passport?<img src={stu.passport} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:18}}>🤒</span>}
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:700,color:"#DC2626"}}>{r.studentName}</div>
                    <div style={{fontSize:12,color:C.textMuted}}>{r.class} · Admitted: {formatDate(r.date)} · {daysIn===0?"Today":daysIn+" day(s) ago"}</div>
                    <div style={{fontSize:12,marginTop:4}}><b>Condition:</b> {r.presentingCondition}</div>
                  </div>
                  {stu&&stu.parentPhone?<div style={{fontSize:11,color:C.textMuted}}>Parent: {stu.parentPhone}</div>:null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* ── TAB: STATISTICS ── */}
      {tab==="stats" ? (
        <div>
          <div style={{marginBottom:14}}>
            <TableActionBar
              title="Clinic Statistics"
              onPrint={function(){
                var hdr = buildDocHeader(settings,"SCHOOL CLINIC STATISTICS — "+CURRENT_TERM+" "+CURRENT_SESSION);
                var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Clinic Statistics</title><style>'+hdr.printStyles+'</style></head><body>'+hdr.headerHtml+
                  '<table><tr><th>Metric</th><th>Value</th></tr>'+
                  '<tr><td>Today</td><td>'+todayRecords.length+'</td></tr>'+
                  '<tr><td>This Term</td><td>'+thisTermVisits+'</td></tr>'+
                  '<tr><td>In Sick Bay</td><td>'+sickBay.length+'</td></tr>'+
                  '<tr><td>Total Records</td><td>'+clinic.length+'</td></tr>'+
                  '<tr><td>Unique Patients</td><td>'+Object.keys(visitMap).length+'</td></tr>'+
                  '</table>'+hdr.footerHtml+'</body></html>';
                printHtmlDoc(html);
              }}
              columns={["Condition","Visits This Term"]}
              rows={conditionStats.map(function(e){return [e[0],e[1]];})}
              filename={"Clinic_Statistics_"+CURRENT_TERM+"_"+CURRENT_SESSION}
            />
          </div>
          <div style={S.statsGrid}>
            {[{l:"Today",v:todayRecords.length,bg:"#FEF2F2"},{l:"This Term",v:thisTermVisits,bg:"#FFF7ED"},{l:"In Sick Bay",v:sickBay.length,bg:"#FEF2F2"},{l:"Total Records",v:clinic.length,bg:"#F5F3FB"},{l:"Unique Patients",v:Object.keys(visitMap).length,bg:"#EFF6FF"},{l:"Referred to Hospital",v:clinic.filter(function(r){return r.disposition==="Referred to hospital"&&r.session===CURRENT_SESSION&&r.term===CURRENT_TERM;}).length,bg:"#FEE2E2"}].map(function(s,i){
              return <div key={i} style={S.statCard(s.bg)}><div style={{...S.statNum,fontSize:20}}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>;
            })}
          </div>
          <div style={{...S.card,marginBottom:14}}>
            <div style={S.cardTitle}>Most Frequent Visitors</div>
            {frequent.length===0?<div style={{color:C.textMuted,fontSize:12,padding:12}}>No records yet.</div>:(
              <table style={S.table}><thead><tr>{["Student","Class","Total Visits"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
              <tbody>{frequent.map(function(f,i){return <tr key={i}><td style={{...S.td,fontWeight:600}}>{f.name}</td><td style={S.td}>{f.class}</td><td style={{...S.tdC,fontWeight:700,color:"#DC2626"}}>{f.count}</td></tr>;})}</tbody></table>
            )}
          </div>
          <div style={S.card}>
            <div style={S.cardTitle}>Common Conditions This Term</div>
            {conditionStats.length===0?<div style={{color:C.textMuted,fontSize:12,padding:12}}>No data this term.</div>:conditionStats.map(function(entry,i){
              var max=conditionStats[0][1];
              return(
                <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"5px 0",borderBottom:"1px solid "+C.border}}>
                  <div style={{width:130,fontSize:11,fontWeight:600}}>{entry[0]}</div>
                  <div style={{flex:1,height:14,background:"#F3F4F6",borderRadius:6,overflow:"hidden"}}><div style={{height:"100%",width:(entry[1]/max*100)+"%",background:"#DC2626",borderRadius:6}}/></div>
                  <div style={{width:28,fontSize:11,fontWeight:700,color:"#DC2626",textAlign:"right"}}>{entry[1]}</div>
                </div>
              );
            })}
          </div>

          {/* Drug Intake Report */}
          <div style={{...S.card,marginTop:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:10}}>
              <div style={S.cardTitle}>💊 Drug Intake Report</div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <select style={S.select} value={drugPeriod} onChange={function(e){setDrugPeriod(e.target.value);}}>
                  <option value="day">Per Day</option>
                  <option value="week">Per Week</option>
                  <option value="month">Per Month</option>
                  <option value="term">Per Term (current)</option>
                </select>
                {drugPeriod!=="term"&&<input style={S.input} type="date" value={drugRefDate} onChange={function(e){setDrugRefDate(e.target.value);}}/>}
              </div>
            </div>
            <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>
              {drugPeriodLabel} · {drugStats.reduce(function(a,e){return a+e[1];},0)} total doses dispensed · {drugStats.length} distinct drugs
            </div>
            <div style={{marginBottom:10}}>
              <TableActionBar
                title={"Drug Intake Report - "+drugPeriodLabel}
                columns={["Drug","Times Dispensed"]}
                rows={drugStats.map(function(e){return [e[0],e[1]];})}
                filename={"Drug_Intake_"+drugPeriod+"_"+(drugPeriod==="term"?CURRENT_TERM+"_"+CURRENT_SESSION:drugRefDate)}
                onPrint={function(){
                  var hdr = buildDocHeader(settings,"CLINIC DRUG INTAKE REPORT");
                  var rowsHtml = drugStats.map(function(e){return '<tr><td>'+e[0]+'</td><td style="text-align:center;font-weight:700;">'+e[1]+'</td></tr>';}).join("");
                  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Drug Intake Report</title><style>'+hdr.printStyles+'</style></head><body>'+hdr.headerHtml+
                    '<div style="margin-bottom:10px;font-size:12px;"><b>Period:</b> '+drugPeriodLabel+'</div>'+
                    '<table><tr><th>Drug</th><th>Times Dispensed</th></tr>'+(rowsHtml||'<tr><td colspan="2" style="text-align:center;">No medications dispensed in this period.</td></tr>')+'</table>'+hdr.footerHtml+'</body></html>';
                  printHtmlDoc(html);
                }}
              />
            </div>
            {drugStats.length===0?<div style={{color:C.textMuted,fontSize:12,padding:12}}>No medications dispensed in this period.</div>:(
              <table style={S.table}><thead><tr>{["Drug","Times Dispensed"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
              <tbody>{drugStats.map(function(e,i){return <tr key={i}><td style={{...S.td,fontWeight:600}}>{e[0]}</td><td style={{...S.tdC,fontWeight:700,color:"#6B491B"}}>{e[1]}</td></tr>;})}</tbody></table>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// HOSTEL & KITCHEN MODULE — raw material inventory/consumption,
// supply requests (Bursar/Admin/Matron approval → Expenditure),
// room allocation, roll call, and hostel discipline
// ══════════════════════════════════════════════════════
var HOSTEL_LOCATIONS = ["Kitchen","Boys Hostel","Girls Hostel"];
var HOSTEL_CATEGORIES = ["Food","Toiletries","Cleaning Supplies","Bedding","Cooking Equipment","Others"];
var HOSTEL_UNITS = ["kg","bag(s)","litre(s)","carton(s)","piece(s)","pack(s)","tuber(s)","dozen(s)"];

function HostelModule({students, staff, settings, currentUser,
  hostelInventory, setHostelInventory,
  hostelConsumption, setHostelConsumption,
  hostelRequests, setHostelRequests,
  hostelRooms, setHostelRooms,
  hostelRollcall, setHostelRollcall,
  hostelIncidents, setHostelIncidents,
  expenditure, setExpenditure
}){
  var _tab = useState("inventory"); var tab = _tab[0]; var setTab = _tab[1];

  var isAdmin = currentUser.role==="root"||currentUser.role==="Admin";
  var myStaffRec = staff.find(function(s){return (s.surname+" "+s.firstname).toLowerCase()===currentUser.name.toLowerCase();});
  var myRole = myStaffRec ? myStaffRec.role : null;
  var canApprove = isAdmin || currentUser.role==="Bursar" || myRole==="Matron";
  var isKitchenRestricted = myRole==="Hostel Master" || myRole==="Hostel Mistress";
  var accessibleHostels = isKitchenRestricted ? ["Boys Hostel","Girls Hostel"] : HOSTEL_LOCATIONS;

  var boarders = students.filter(function(s){return s.active && s.boardingType==="Boarder";});
  function boysGirlsFor(hostel){ return hostel==="Boys Hostel" ? "Male" : hostel==="Girls Hostel" ? "Female" : null; }

  // ═══════════════════ INVENTORY ═══════════════════
  var _invFilter = useState(accessibleHostels[0]); var invFilter = _invFilter[0]; var setInvFilter = _invFilter[1];
  var _showItemForm = useState(false); var showItemForm = _showItemForm[0]; var setShowItemForm = _showItemForm[1];
  var _editingItem = useState(null); var editingItem = _editingItem[0]; var setEditingItem = _editingItem[1];
  var emptyItemForm = {name:"", category:"Food", unit:"kg", currentStock:0, reorderLevel:0, hostel:invFilter||accessibleHostels[0]};
  var _itemForm = useState(emptyItemForm); var itemForm = _itemForm[0]; var setItemForm = _itemForm[1];
  var _consuming = useState(null); var consuming = _consuming[0]; var setConsuming = _consuming[1];
  var _consumeQty = useState(""); var consumeQty = _consumeQty[0]; var setConsumeQty = _consumeQty[1];
  var _restocking = useState(null); var restocking = _restocking[0]; var setRestocking = _restocking[1];
  var _restockQty = useState(""); var restockQty = _restockQty[0]; var setRestockQty = _restockQty[1];

  var visibleInventory = hostelInventory.filter(function(i){return accessibleHostels.includes(i.hostel) && (!invFilter||i.hostel===invFilter);});

  function openAddItem(){ setEditingItem(null); setItemForm({...emptyItemForm, hostel:invFilter||accessibleHostels[0]}); setShowItemForm(true); }
  function openEditItem(item){ setEditingItem(item); setItemForm({...item}); setShowItemForm(true); }
  function saveItem(){
    if(!itemForm.name.trim()) return alert("Item name is required.");
    if(editingItem){
      setHostelInventory(function(p){return p.map(function(i){return i.id===editingItem.id?{...itemForm,id:editingItem.id}:i;});});
    } else {
      setHostelInventory(function(p){return [...p, {...itemForm, id:genId(), currentStock:parseFloat(itemForm.currentStock)||0, reorderLevel:parseFloat(itemForm.reorderLevel)||0}];});
    }
    setShowItemForm(false);
  }
  function deleteItem(id){
    if(window.confirm("Delete this inventory item? This cannot be undone.")) setHostelInventory(function(p){return p.filter(function(i){return i.id!==id;});});
  }
  function logConsumption(){
    var qty = parseFloat(consumeQty);
    if(!qty || qty<=0) return alert("Enter a valid quantity.");
    if(qty > consuming.currentStock) { if(!window.confirm("This exceeds current stock ("+consuming.currentStock+" "+consuming.unit+"). Log anyway?")) return; }
    setHostelInventory(function(p){return p.map(function(i){return i.id===consuming.id?{...i,currentStock:Math.max(0,i.currentStock-qty)}:i;});});
    setHostelConsumption(function(p){return [{id:genId(), itemId:consuming.id, itemName:consuming.name, hostel:consuming.hostel, quantity:qty, unit:consuming.unit, date:today(), loggedBy:currentUser.name, session:CURRENT_SESSION, term:CURRENT_TERM}, ...p];});
    setConsuming(null); setConsumeQty("");
  }
  function restockItem(){
    var qty = parseFloat(restockQty);
    if(!qty || qty<=0) return alert("Enter a valid quantity.");
    setHostelInventory(function(p){return p.map(function(i){return i.id===restocking.id?{...i,currentStock:i.currentStock+qty}:i;});});
    setRestocking(null); setRestockQty("");
  }

  function renderInventory(){
    return(<div>
      <div style={{...S.card,marginBottom:14}}>
        <div style={{...S.row,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {accessibleHostels.map(function(h){return <button key={h} style={{...S.btn(invFilter===h?"primary":"secondary"),fontSize:11}} onClick={function(){setInvFilter(h);}}>{h}</button>;})}
          </div>
          <button style={S.btn()} onClick={openAddItem}><span style={S.row}><Icon name="plus" size={13}/>Add Item</span></button>
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <TableActionBar title={"Hostel Inventory - "+(invFilter||"All")} columns={["Item","Category","Hostel","Stock","Unit","Reorder Level"]}
          rows={visibleInventory.map(function(i){return [i.name,i.category,i.hostel,i.currentStock,i.unit,i.reorderLevel];})}
          filename={"Hostel_Inventory_"+(invFilter||"All")}/>
      </div>
      {visibleInventory.length===0?<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No items in {invFilter||"this hostel"} yet.</div>:(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
          {visibleInventory.map(function(item){
            var low = item.currentStock<=item.reorderLevel;
            return(
              <div key={item.id} style={{...S.card,margin:0,borderLeft:"4px solid "+(low?"#DC2626":"#059669")}}>
                <div style={{...S.row,justifyContent:"space-between"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#230E6A"}}>{item.name}</div>
                  {low&&<span style={S.badge("red")}>⚠ Low Stock</span>}
                </div>
                <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{item.category} · {item.hostel}</div>
                <div style={{fontSize:20,fontWeight:900,color:low?"#DC2626":"#059669",marginTop:8}}>{item.currentStock} <span style={{fontSize:12,fontWeight:600}}>{item.unit}</span></div>
                <div style={{fontSize:10,color:C.textMuted}}>Reorder at {item.reorderLevel} {item.unit}</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
                  <button style={{...S.btn("blue"),fontSize:10,padding:"4px 8px"}} onClick={function(){setConsuming(item);setConsumeQty("");}}>📉 Log Use</button>
                  <button style={{...S.btn("green"),fontSize:10,padding:"4px 8px"}} onClick={function(){setRestocking(item);setRestockQty("");}}>📈 Restock</button>
                  <button style={{...S.btn("secondary"),fontSize:10,padding:"4px 8px"}} onClick={function(){openEditItem(item);}}>Edit</button>
                  <button style={{...S.btn("danger"),fontSize:10,padding:"4px 8px"}} onClick={function(){deleteItem(item.id);}}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={showItemForm} onClose={function(){setShowItemForm(false);}} title={editingItem?"Edit Item":"Add Inventory Item"}>
        <div style={S.formGroup}><label style={S.label}>Item Name *</label><input style={S.input} value={itemForm.name} onChange={function(e){setItemForm(function(p){return{...p,name:e.target.value};});}} placeholder="e.g. Rice, Vegetable Oil, Toilet Roll..."/></div>
        <div style={S.grid2}>
          <div style={S.formGroup}><label style={S.label}>Category</label><select style={{...S.select,width:"100%"}} value={itemForm.category} onChange={function(e){setItemForm(function(p){return{...p,category:e.target.value};});}}>{HOSTEL_CATEGORIES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
          <div style={S.formGroup}><label style={S.label}>Hostel/Location</label><select style={{...S.select,width:"100%"}} value={itemForm.hostel} onChange={function(e){setItemForm(function(p){return{...p,hostel:e.target.value};});}}>{accessibleHostels.map(function(h){return <option key={h}>{h}</option>;})}</select></div>
        </div>
        <div style={S.grid3}>
          <div style={S.formGroup}><label style={S.label}>Current Stock</label><input type="number" style={S.input} value={itemForm.currentStock} onChange={function(e){setItemForm(function(p){return{...p,currentStock:e.target.value};});}}/></div>
          <div style={S.formGroup}><label style={S.label}>Unit</label><select style={{...S.select,width:"100%"}} value={itemForm.unit} onChange={function(e){setItemForm(function(p){return{...p,unit:e.target.value};});}}>{HOSTEL_UNITS.map(function(u){return <option key={u}>{u}</option>;})}</select></div>
          <div style={S.formGroup}><label style={S.label}>Reorder Level</label><input type="number" style={S.input} value={itemForm.reorderLevel} onChange={function(e){setItemForm(function(p){return{...p,reorderLevel:e.target.value};});}}/></div>
        </div>
        <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={function(){setShowItemForm(false);}}>Cancel</button><button style={S.btn()} onClick={saveItem}>{editingItem?"Save Changes":"Add Item"}</button></div>
      </Modal>

      <Modal open={!!consuming} onClose={function(){setConsuming(null);}} title={"Log Consumption — "+(consuming?consuming.name:"")}>
        {consuming&&<div>
          <div style={{fontSize:12,color:C.textMuted,marginBottom:10}}>Current stock: {consuming.currentStock} {consuming.unit}</div>
          <div style={S.formGroup}><label style={S.label}>Quantity Used *</label><input type="number" style={S.input} value={consumeQty} onChange={function(e){setConsumeQty(e.target.value);}} placeholder={"e.g. 5 "+consuming.unit}/></div>
          <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={function(){setConsuming(null);}}>Cancel</button><button style={S.btn("blue")} onClick={logConsumption}>Log Consumption</button></div>
        </div>}
      </Modal>

      <Modal open={!!restocking} onClose={function(){setRestocking(null);}} title={"Restock — "+(restocking?restocking.name:"")}>
        {restocking&&<div>
          <div style={{fontSize:12,color:C.textMuted,marginBottom:10}}>Current stock: {restocking.currentStock} {restocking.unit}</div>
          <div style={S.formGroup}><label style={S.label}>Quantity Added *</label><input type="number" style={S.input} value={restockQty} onChange={function(e){setRestockQty(e.target.value);}} placeholder={"e.g. 25 "+restocking.unit}/></div>
          <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={function(){setRestocking(null);}}>Cancel</button><button style={S.btn("green")} onClick={restockItem}>Add Stock</button></div>
        </div>}
      </Modal>
    </div>);
  }

  // ═══════════════════ REQUESTS ═══════════════════
  var _showReqForm = useState(false); var showReqForm = _showReqForm[0]; var setShowReqForm = _showReqForm[1];
  var emptyReqForm = {hostel:accessibleHostels[0], itemName:"", category:"Food", quantityRequested:"", unit:"kg", urgency:"Normal", reason:"", costPerUnit:""};
  var _reqForm = useState(emptyReqForm); var reqForm = _reqForm[0]; var setReqForm = _reqForm[1];

  var visibleRequests = hostelRequests.filter(function(r){return accessibleHostels.includes(r.hostel);}).sort(function(a,b){return b.requestedAt.localeCompare(a.requestedAt);});

  function submitRequest(){
    if(!reqForm.itemName.trim()) return alert("Item name is required.");
    if(!parseFloat(reqForm.quantityRequested)) return alert("Enter a valid quantity.");
    setHostelRequests(function(p){return [{...reqForm, id:genId(), quantityRequested:parseFloat(reqForm.quantityRequested), costPerUnit:parseFloat(reqForm.costPerUnit)||0,
      status:"Pending", requestedBy:currentUser.name, requestedAt:today()}, ...p];});
    setReqForm(emptyReqForm); setShowReqForm(false);
  }

  function approveAndFulfill(req){
    var costStr = window.prompt("Confirm total cost for this request (₦):", (req.costPerUnit*req.quantityRequested)||"");
    if(costStr===null) return;
    var totalCost = parseFloat(costStr)||0;
    var expId = genId();

    setHostelRequests(function(p){return p.map(function(r){return r.id===req.id?{...r,status:"Fulfilled",approvedBy:currentUser.name,approvedAt:today(),totalCost:totalCost,linkedExpenditureId:expId}:r;});});

    // Bump matching inventory item (or create one) so stock reflects the fulfilled request
    setHostelInventory(function(p){
      var existing = p.find(function(i){return i.hostel===req.hostel && i.name.toLowerCase()===req.itemName.toLowerCase();});
      if(existing) return p.map(function(i){return i.id===existing.id?{...i,currentStock:i.currentStock+req.quantityRequested}:i;});
      return [...p, {id:genId(), name:req.itemName, category:req.category, unit:req.unit, currentStock:req.quantityRequested, reorderLevel:0, hostel:req.hostel}];
    });

    if(totalCost>0){
      setExpenditure(function(p){return [...p, {id:expId, date:today(), amount:totalCost, category:"Hostel & Kitchen Supplies", reason:req.itemName+" ("+req.quantityRequested+" "+req.unit+") — "+req.hostel, recordedBy:currentUser.name}];});
    }
  }
  function rejectRequest(req){
    var reason = window.prompt("Reason for rejecting this request (optional):", "");
    if(reason===null) return;
    setHostelRequests(function(p){return p.map(function(r){return r.id===req.id?{...r,status:"Rejected",approvedBy:currentUser.name,approvedAt:today(),rejectionReason:reason}:r;});});
  }

  function renderRequests(){
    return(<div>
      <div style={{...S.card,marginBottom:14}}>
        <div style={{...S.row,justifyContent:"space-between"}}>
          <div style={S.cardTitle}>Raw Material / Supply Requests</div>
          <button style={S.btn()} onClick={function(){setReqForm({...emptyReqForm,hostel:accessibleHostels[0]});setShowReqForm(true);}}><span style={S.row}><Icon name="plus" size={13}/>New Request</span></button>
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <TableActionBar title="Hostel Requests" columns={["Hostel","Item","Qty","Status","Requested By","Date"]}
          rows={visibleRequests.map(function(r){return [r.hostel,r.itemName,r.quantityRequested+" "+r.unit,r.status,r.requestedBy,formatDate(r.requestedAt)];})}
          filename="Hostel_Requests"/>
      </div>
      {visibleRequests.length===0?<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No requests yet.</div>:
        visibleRequests.map(function(r){
          return(
            <div key={r.id} style={S.card}>
              <div style={{...S.row,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                <div>
                  <div style={{...S.row,gap:8}}>
                    <span style={{fontSize:13,fontWeight:700,color:"#230E6A"}}>{r.itemName}</span>
                    <span style={S.badge("blue")}>{r.hostel}</span>
                    <span style={S.badge(r.urgency==="Urgent"?"red":"yellow")}>{r.urgency}</span>
                    <span style={S.badge(r.status==="Fulfilled"?"green":r.status==="Rejected"?"red":"yellow")}>{r.status}</span>
                  </div>
                  <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>Qty: {r.quantityRequested} {r.unit} · Requested by {r.requestedBy} on {formatDate(r.requestedAt)}</div>
                  {r.reason&&<div style={{fontSize:12,marginTop:4}}>{r.reason}</div>}
                  {r.status==="Fulfilled"&&<div style={{fontSize:11,color:"#059669",marginTop:4}}>✓ Approved by {r.approvedBy} · Cost: ₦{(r.totalCost||0).toLocaleString()}</div>}
                  {r.status==="Rejected"&&<div style={{fontSize:11,color:"#DC2626",marginTop:4}}>✗ Rejected by {r.approvedBy}{r.rejectionReason?": "+r.rejectionReason:""}</div>}
                </div>
                {canApprove&&r.status==="Pending"&&<div style={{display:"flex",gap:6,flexShrink:0}}>
                  <button style={{...S.btn("green"),fontSize:11}} onClick={function(){approveAndFulfill(r);}}>✓ Approve &amp; Fulfill</button>
                  <button style={{...S.btn("danger"),fontSize:11}} onClick={function(){rejectRequest(r);}}>✗ Reject</button>
                </div>}
              </div>
            </div>
          );
        })}

      <Modal open={showReqForm} onClose={function(){setShowReqForm(false);}} title="New Supply Request">
        <div style={S.grid2}>
          <div style={S.formGroup}><label style={S.label}>Hostel/Location *</label><select style={{...S.select,width:"100%"}} value={reqForm.hostel} onChange={function(e){setReqForm(function(p){return{...p,hostel:e.target.value};});}}>{accessibleHostels.map(function(h){return <option key={h}>{h}</option>;})}</select></div>
          <div style={S.formGroup}><label style={S.label}>Category</label><select style={{...S.select,width:"100%"}} value={reqForm.category} onChange={function(e){setReqForm(function(p){return{...p,category:e.target.value};});}}>{HOSTEL_CATEGORIES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
        </div>
        <div style={S.formGroup}><label style={S.label}>Item Name *</label><input style={S.input} value={reqForm.itemName} onChange={function(e){setReqForm(function(p){return{...p,itemName:e.target.value};});}} placeholder="e.g. Rice, Groundnut Oil, Detergent..."/></div>
        <div style={S.grid3}>
          <div style={S.formGroup}><label style={S.label}>Quantity *</label><input type="number" style={S.input} value={reqForm.quantityRequested} onChange={function(e){setReqForm(function(p){return{...p,quantityRequested:e.target.value};});}}/></div>
          <div style={S.formGroup}><label style={S.label}>Unit</label><select style={{...S.select,width:"100%"}} value={reqForm.unit} onChange={function(e){setReqForm(function(p){return{...p,unit:e.target.value};});}}>{HOSTEL_UNITS.map(function(u){return <option key={u}>{u}</option>;})}</select></div>
          <div style={S.formGroup}><label style={S.label}>Est. Cost/Unit (₦)</label><input type="number" style={S.input} value={reqForm.costPerUnit} onChange={function(e){setReqForm(function(p){return{...p,costPerUnit:e.target.value};});}}/></div>
        </div>
        <div style={S.formGroup}><label style={S.label}>Urgency</label><select style={{...S.select,width:"100%"}} value={reqForm.urgency} onChange={function(e){setReqForm(function(p){return{...p,urgency:e.target.value};});}}><option>Normal</option><option>Urgent</option></select></div>
        <div style={S.formGroup}><label style={S.label}>Reason / Notes</label><textarea style={{...S.textarea,minHeight:60}} value={reqForm.reason} onChange={function(e){setReqForm(function(p){return{...p,reason:e.target.value};});}}/></div>
        <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={function(){setShowReqForm(false);}}>Cancel</button><button style={S.btn()} onClick={submitRequest}>Submit Request</button></div>
      </Modal>
    </div>);
  }

  // ═══════════════════ ROOMS & ALLOCATION ═══════════════════
  var _roomHostel = useState("Boys Hostel"); var roomHostel = _roomHostel[0]; var setRoomHostel = _roomHostel[1];
  var _showRoomForm = useState(false); var showRoomForm = _showRoomForm[0]; var setShowRoomForm = _showRoomForm[1];
  var emptyRoomForm = {hostel:"Boys Hostel", roomName:"", capacity:4};
  var _roomForm = useState(emptyRoomForm); var roomForm = _roomForm[0]; var setRoomForm = _roomForm[1];
  var _assigningRoom = useState(null); var assigningRoom = _assigningRoom[0]; var setAssigningRoom = _assigningRoom[1];
  var _assignStudentId = useState(""); var assignStudentId = _assignStudentId[0]; var setAssignStudentId = _assignStudentId[1];

  var roomsForHostel = hostelRooms.filter(function(r){return r.hostel===roomHostel;});
  var allocatedIds = hostelRooms.reduce(function(acc,r){return acc.concat(r.occupantIds||[]);},[]);
  var unallocatedBoarders = boarders.filter(function(s){return s.gender===boysGirlsFor(roomHostel) && allocatedIds.indexOf(s.id)===-1;});

  function saveRoom(){
    if(!roomForm.roomName.trim()) return alert("Room name/number is required.");
    setHostelRooms(function(p){return [...p, {...roomForm, id:genId(), capacity:parseInt(roomForm.capacity)||1, occupantIds:[]}];});
    setShowRoomForm(false);
  }
  function deleteRoom(id){
    if(window.confirm("Delete this room? Occupants will need to be reassigned.")) setHostelRooms(function(p){return p.filter(function(r){return r.id!==id;});});
  }
  function assignToRoom(){
    if(!assignStudentId) return;
    setHostelRooms(function(p){return p.map(function(r){return r.id===assigningRoom.id?{...r,occupantIds:[...(r.occupantIds||[]),assignStudentId]}:r;});});
    setAssignStudentId("");
  }
  function removeFromRoom(room, studentId){
    setHostelRooms(function(p){return p.map(function(r){return r.id===room.id?{...r,occupantIds:(r.occupantIds||[]).filter(function(id){return id!==studentId;})}:r;});});
  }

  function renderRooms(){
    return(<div>
      <div style={{...S.card,marginBottom:14}}>
        <div style={{...S.row,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex",gap:6}}>
            {["Boys Hostel","Girls Hostel"].map(function(h){return <button key={h} style={{...S.btn(roomHostel===h?"primary":"secondary"),fontSize:11}} onClick={function(){setRoomHostel(h);}}>{h}</button>;})}
          </div>
          <button style={S.btn()} onClick={function(){setRoomForm({...emptyRoomForm,hostel:roomHostel});setShowRoomForm(true);}}><span style={S.row}><Icon name="plus" size={13}/>Add Room</span></button>
        </div>
        <div style={{fontSize:11,color:C.textMuted,marginTop:8}}>{roomsForHostel.length} rooms · {roomsForHostel.reduce(function(a,r){return a+(r.occupantIds||[]).length;},0)} of {roomsForHostel.reduce(function(a,r){return a+r.capacity;},0)} beds occupied · {unallocatedBoarders.length} unallocated boarders in this hostel</div>
      </div>
      <div style={{marginBottom:10}}>
        <TableActionBar title={"Hostel Rooms - "+roomHostel} columns={["Room","Capacity","Occupants"]}
          rows={roomsForHostel.map(function(r){return [r.roomName,r.capacity,(r.occupantIds||[]).length];})}
          filename={"Hostel_Rooms_"+roomHostel}/>
      </div>
      {roomsForHostel.length===0?<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No rooms set up for {roomHostel} yet.</div>:(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12}}>
          {roomsForHostel.map(function(room){
            var occupants = (room.occupantIds||[]).map(function(id){return students.find(function(s){return s.id===id;});}).filter(Boolean);
            var full = occupants.length>=room.capacity;
            return(
              <div key={room.id} style={{...S.card,margin:0,borderLeft:"4px solid "+(full?"#D97706":"#059669")}}>
                <div style={{...S.row,justifyContent:"space-between"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#230E6A"}}>{room.roomName}</div>
                  <button style={{...S.btn("danger"),fontSize:9,padding:"2px 6px"}} onClick={function(){deleteRoom(room.id);}}>🗑</button>
                </div>
                <div style={{fontSize:11,color:C.textMuted,marginBottom:8}}>{occupants.length}/{room.capacity} beds{full?" — FULL":""}</div>
                {occupants.map(function(s){return(
                  <div key={s.id} style={{...S.row,justifyContent:"space-between",fontSize:11,padding:"3px 0",borderBottom:"1px solid "+C.border}}>
                    <span>{s.surname} {s.firstname} ({s.class}{s.arm})</span>
                    <button style={{background:"none",border:"none",color:C.danger,cursor:"pointer",fontSize:12}} onClick={function(){removeFromRoom(room,s.id);}}>✕</button>
                  </div>
                );})}
                {!full&&<button style={{...S.btn("secondary"),fontSize:10,marginTop:8,width:"100%"}} onClick={function(){setAssigningRoom(room);setAssignStudentId("");}}>+ Assign Boarder</button>}
              </div>
            );
          })}
        </div>
      )}

      <Modal open={showRoomForm} onClose={function(){setShowRoomForm(false);}} title="Add Room">
        <div style={S.formGroup}><label style={S.label}>Hostel</label><select style={{...S.select,width:"100%"}} value={roomForm.hostel} onChange={function(e){setRoomForm(function(p){return{...p,hostel:e.target.value};});}}><option>Boys Hostel</option><option>Girls Hostel</option></select></div>
        <div style={S.formGroup}><label style={S.label}>Room Name/Number *</label><input style={S.input} value={roomForm.roomName} onChange={function(e){setRoomForm(function(p){return{...p,roomName:e.target.value};});}} placeholder="e.g. Block A Room 3"/></div>
        <div style={S.formGroup}><label style={S.label}>Capacity (beds)</label><input type="number" style={S.input} value={roomForm.capacity} onChange={function(e){setRoomForm(function(p){return{...p,capacity:e.target.value};});}}/></div>
        <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={function(){setShowRoomForm(false);}}>Cancel</button><button style={S.btn()} onClick={saveRoom}>Add Room</button></div>
      </Modal>

      <Modal open={!!assigningRoom} onClose={function(){setAssigningRoom(null);}} title={"Assign Boarder — "+(assigningRoom?assigningRoom.roomName:"")}>
        {assigningRoom&&<div>
          <select style={{...S.select,width:"100%"}} value={assignStudentId} onChange={function(e){setAssignStudentId(e.target.value);}}>
            <option value="">— Select unallocated boarder —</option>
            {unallocatedBoarders.map(function(s){return <option key={s.id} value={s.id}>{s.surname} {s.firstname} ({s.class}{s.arm})</option>;})}
          </select>
          {unallocatedBoarders.length===0&&<div style={{fontSize:11,color:C.textMuted,marginTop:8}}>No unallocated boarders left in {roomHostel}.</div>}
          <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={function(){setAssigningRoom(null);}}>Cancel</button><button style={S.btn()} disabled={!assignStudentId} onClick={assignToRoom}>Assign</button></div>
        </div>}
      </Modal>
    </div>);
  }

  // ═══════════════════ ROLL CALL ═══════════════════
  var _rcHostel = useState("Boys Hostel"); var rcHostel = _rcHostel[0]; var setRcHostel = _rcHostel[1];
  var _rcDate = useState(today()); var rcDate = _rcDate[0]; var setRcDate = _rcDate[1];

  var rcBoarders = boarders.filter(function(s){return s.gender===boysGirlsFor(rcHostel);});
  var existingRc = hostelRollcall.find(function(r){return r.hostel===rcHostel && r.date===rcDate;});
  var rcPresent = existingRc ? (existingRc.presentStudentIds||[]) : [];

  function toggleRollcall(studentId){
    var isPresent = rcPresent.indexOf(studentId)!==-1;
    var newPresent = isPresent ? rcPresent.filter(function(id){return id!==studentId;}) : [...rcPresent, studentId];
    if(existingRc){
      setHostelRollcall(function(p){return p.map(function(r){return r.id===existingRc.id?{...r,presentStudentIds:newPresent,takenBy:currentUser.name}:r;});});
    } else {
      setHostelRollcall(function(p){return [...p, {id:genId(), hostel:rcHostel, date:rcDate, presentStudentIds:newPresent, takenBy:currentUser.name}];});
    }
  }
  function markAll(present){
    var ids = present ? rcBoarders.map(function(s){return s.id;}) : [];
    if(existingRc){
      setHostelRollcall(function(p){return p.map(function(r){return r.id===existingRc.id?{...r,presentStudentIds:ids,takenBy:currentUser.name}:r;});});
    } else {
      setHostelRollcall(function(p){return [...p, {id:genId(), hostel:rcHostel, date:rcDate, presentStudentIds:ids, takenBy:currentUser.name}];});
    }
  }

  function renderRollcall(){
    var absentCount = rcBoarders.length - rcPresent.length;
    return(<div>
      <div style={{...S.card,marginBottom:14}}>
        <div style={{...S.row,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            {["Boys Hostel","Girls Hostel"].map(function(h){return <button key={h} style={{...S.btn(rcHostel===h?"primary":"secondary"),fontSize:11}} onClick={function(){setRcHostel(h);}}>{h}</button>;})}
            <input style={S.input} type="date" value={rcDate} onChange={function(e){setRcDate(e.target.value);}}/>
          </div>
          <div style={{display:"flex",gap:6}}>
            <button style={{...S.btn("green"),fontSize:11}} onClick={function(){markAll(true);}}>Mark All Present</button>
            <button style={{...S.btn("danger"),fontSize:11}} onClick={function(){markAll(false);}}>Clear All</button>
          </div>
        </div>
        <div style={{fontSize:11,color:C.textMuted,marginTop:8}}>{rcPresent.length} present · {absentCount} absent · {rcBoarders.length} total boarders</div>
      </div>
      <div style={{marginBottom:10}}>
        <TableActionBar title={"Roll Call - "+rcHostel+" - "+formatDate(rcDate)} columns={["Student","Class","Status"]}
          rows={rcBoarders.map(function(s){return [s.surname+" "+s.firstname, s.class+s.arm, rcPresent.indexOf(s.id)!==-1?"Present":"Absent"];})}
          filename={"Rollcall_"+rcHostel+"_"+rcDate}/>
      </div>
      {rcBoarders.length===0?<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No boarders found for {rcHostel}.</div>:(
        <div style={S.card}>
          <table style={S.table}><thead><tr>{["Student","Class","Status"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
            <tbody>{rcBoarders.map(function(s){
              var present = rcPresent.indexOf(s.id)!==-1;
              return(
                <tr key={s.id}>
                  <td style={{...S.td,fontWeight:600}}>{s.surname} {s.firstname}</td>
                  <td style={S.td}>{s.class}{s.arm}</td>
                  <td style={S.tdC}><button style={{...S.btn(present?"green":"danger"),fontSize:10,padding:"3px 10px"}} onClick={function(){toggleRollcall(s.id);}}>{present?"✓ Present":"✗ Absent"}</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </div>);
  }

  // ═══════════════════ INCIDENTS ═══════════════════
  var _showIncForm = useState(false); var showIncForm = _showIncForm[0]; var setShowIncForm = _showIncForm[1];
  var emptyIncForm = {hostel:"Boys Hostel", studentId:"", incidentType:"", severity:"Minor", description:"", actionTaken:"", status:"Open"};
  var _incForm = useState(emptyIncForm); var incForm = _incForm[0]; var setIncForm = _incForm[1];

  function saveIncident(){
    var stu = students.find(function(s){return s.id===incForm.studentId;});
    if(!stu) return alert("Select a student.");
    if(!incForm.incidentType.trim()) return alert("Incident type is required.");
    setHostelIncidents(function(p){return [{...incForm, id:genId(), studentName:stu.surname+" "+stu.firstname, class:stu.class+stu.arm, date:today(), reportedBy:currentUser.name}, ...p];});
    setIncForm(emptyIncForm); setShowIncForm(false);
  }
  function toggleIncidentStatus(inc){
    setHostelIncidents(function(p){return p.map(function(i){return i.id===inc.id?{...i,status:i.status==="Open"?"Resolved":"Open"}:i;});});
  }

  function renderIncidents(){
    var visibleIncidents = hostelIncidents.filter(function(i){return ["Boys Hostel","Girls Hostel"].includes(i.hostel);}).sort(function(a,b){return b.date.localeCompare(a.date);});
    var incidentStudents = students.filter(function(s){return s.active && s.boardingType==="Boarder" && s.gender===boysGirlsFor(incForm.hostel);});
    return(<div>
      <div style={{...S.card,marginBottom:14}}>
        <div style={{...S.row,justifyContent:"space-between"}}>
          <div style={S.cardTitle}>Hostel Discipline / Incidents</div>
          <button style={S.btn()} onClick={function(){setIncForm(emptyIncForm);setShowIncForm(true);}}><span style={S.row}><Icon name="plus" size={13}/>Log Incident</span></button>
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <TableActionBar title="Hostel Incidents" columns={["Student","Hostel","Type","Severity","Status","Date"]}
          rows={visibleIncidents.map(function(i){return [i.studentName,i.hostel,i.incidentType,i.severity,i.status,formatDate(i.date)];})}
          filename="Hostel_Incidents"/>
      </div>
      {visibleIncidents.length===0?<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No incidents logged.</div>:
        visibleIncidents.map(function(inc){
          return(
            <div key={inc.id} style={S.card}>
              <div style={{...S.row,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                <div>
                  <div style={{...S.row,gap:8}}>
                    <span style={{fontSize:13,fontWeight:700,color:"#230E6A"}}>{inc.studentName}</span>
                    <span style={S.badge("blue")}>{inc.hostel}</span>
                    <span style={S.badge(inc.severity==="Severe"?"red":inc.severity==="Moderate"?"yellow":"green")}>{inc.severity}</span>
                    <span style={S.badge(inc.status==="Open"?"red":"green")}>{inc.status}</span>
                  </div>
                  <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{inc.class} · {formatDate(inc.date)} · Reported by {inc.reportedBy}</div>
                  <div style={{fontSize:12,marginTop:4}}><b>{inc.incidentType}:</b> {inc.description}</div>
                  {inc.actionTaken&&<div style={{fontSize:11,color:C.textMuted,marginTop:2}}>Action taken: {inc.actionTaken}</div>}
                </div>
                <button style={{...S.btn(inc.status==="Open"?"green":"secondary"),fontSize:10,flexShrink:0}} onClick={function(){toggleIncidentStatus(inc);}}>{inc.status==="Open"?"Mark Resolved":"Reopen"}</button>
              </div>
            </div>
          );
        })}

      <Modal open={showIncForm} onClose={function(){setShowIncForm(false);}} title="Log Hostel Incident">
        <div style={S.grid2}>
          <div style={S.formGroup}><label style={S.label}>Hostel *</label><select style={{...S.select,width:"100%"}} value={incForm.hostel} onChange={function(e){setIncForm(function(p){return{...p,hostel:e.target.value,studentId:""};});}}><option>Boys Hostel</option><option>Girls Hostel</option></select></div>
          <div style={S.formGroup}><label style={S.label}>Student *</label><select style={{...S.select,width:"100%"}} value={incForm.studentId} onChange={function(e){setIncForm(function(p){return{...p,studentId:e.target.value};});}}><option value="">— Select —</option>{incidentStudents.map(function(s){return <option key={s.id} value={s.id}>{s.surname} {s.firstname} ({s.class}{s.arm})</option>;})}</select></div>
        </div>
        <div style={S.grid2}>
          <div style={S.formGroup}><label style={S.label}>Incident Type *</label><input style={S.input} value={incForm.incidentType} onChange={function(e){setIncForm(function(p){return{...p,incidentType:e.target.value};});}} placeholder="e.g. Lights-out violation, Unauthorized outing..."/></div>
          <div style={S.formGroup}><label style={S.label}>Severity</label><select style={{...S.select,width:"100%"}} value={incForm.severity} onChange={function(e){setIncForm(function(p){return{...p,severity:e.target.value};});}}><option>Minor</option><option>Moderate</option><option>Severe</option></select></div>
        </div>
        <div style={S.formGroup}><label style={S.label}>Description</label><textarea style={{...S.textarea,minHeight:60}} value={incForm.description} onChange={function(e){setIncForm(function(p){return{...p,description:e.target.value};});}}/></div>
        <div style={S.formGroup}><label style={S.label}>Action Taken</label><textarea style={{...S.textarea,minHeight:50}} value={incForm.actionTaken} onChange={function(e){setIncForm(function(p){return{...p,actionTaken:e.target.value};});}}/></div>
        <div style={{...S.row,justifyContent:"flex-end",marginTop:14,gap:8}}><button style={S.btn("secondary")} onClick={function(){setShowIncForm(false);}}>Cancel</button><button style={S.btn()} onClick={saveIncident}>Log Incident</button></div>
      </Modal>
    </div>);
  }

  return(
    <div>
      {isKitchenRestricted&&<div style={{...S.card,marginBottom:14,background:"#FFFBEB",border:"1px solid #F0C060"}}>
        <div style={{fontSize:11,color:"#92400E"}}>ℹ You have Hostel Master/Mistress access — Boys/Girls Hostel only. Kitchen inventory and requests are not shown.</div>
      </div>}
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border,flexWrap:"wrap"}}>
        {[["inventory","📦 Inventory"],["requests","📝 Requests"],["rooms","🛏 Rooms"],["rollcall","✅ Roll Call"],["incidents","⚠ Incidents"]].map(function(pair){
          return <button key={pair[0]} onClick={function(){setTab(pair[0]);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 14px"}}>{pair[1]}</button>;
        })}
      </div>
      {tab==="inventory"?renderInventory():null}
      {tab==="requests"?renderRequests():null}
      {tab==="rooms"?renderRooms():null}
      {tab==="rollcall"?renderRollcall():null}
      {tab==="incidents"?renderIncidents():null}
    </div>
  );
}


function ParentPortal({student, students, results, attendance, fees, settings, diary, elibrary, lessons, assignments, submissions, exams, gallery, parentToken, onRefresh, onLogout}){
  var _tab = useState("home"); var tab = _tab[0]; var setTab = _tab[1];
  var _selSess = useState(CURRENT_SESSION); var selSess = _selSess[0]; var setSelSess = _selSess[1];
  var _selTerm = useState(CURRENT_TERM); var selTerm = _selTerm[0]; var setSelTerm = _selTerm[1];
  var _selLesson = useState(null); var selLesson = _selLesson[0]; var setSelLesson = _selLesson[1];
  var _activeAttempt = useState(null); var activeAttempt = _activeAttempt[0]; var setActiveAttempt = _activeAttempt[1];
  var _examResult = useState(null); var examResult = _examResult[0]; var setExamResult = _examResult[1];
  var _loadingExam = useState(false); var loadingExam = _loadingExam[0]; var setLoadingExam = _loadingExam[1];
  var _remainingSec = useState(null); var remainingSec = _remainingSec[0]; var setRemainingSec = _remainingSec[1];
  var _submittingAsn = useState(null); var submittingAsn = _submittingAsn[0]; var setSubmittingAsn = _submittingAsn[1];
  var _submissionText = useState(""); var submissionText = _submissionText[0]; var setSubmissionText = _submissionText[1];
  var _submitBusy = useState(false); var submitBusy = _submitBusy[0]; var setSubmitBusy = _submitBusy[1];

  var logo = settings.schoolLogo || "";
  var rc = getResultConfig(settings);

  function submitAssignmentAnswer(assignmentId){
    if(!submissionText.trim()) return alert("Please write an answer before submitting.");
    setSubmitBusy(true);
    fetch("/api/parent-assignment", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+parentToken},
      body:JSON.stringify({action:"submit", assignmentId:assignmentId, content:submissionText})
    }).then(function(r){ return r.json(); }).then(function(res){
      setSubmitBusy(false);
      if(res.error) return alert(res.error);
      setSubmittingAsn(null);
      setSubmissionText("");
      if(onRefresh) onRefresh();
      alert("Assignment submitted successfully!");
    }).catch(function(e){ setSubmitBusy(false); alert("Could not submit: "+e.message); });
  }

  // ── Child's data ────────────────────────────────────
  var childResults = results.filter(function(r){ return r.studentId === student.id; });
  var termResults = childResults.filter(function(r){ return r.session===selSess && r.term===selTerm; });
  var childAttendance = attendance.filter(function(a){ return a.studentId === student.id; });
  var termAttendance = childAttendance.filter(function(a){ return a.session===selSess && a.term===selTerm; });
  var childFees = fees.filter(function(f){ return f.studentId === student.id; });
  var termFees = childFees.filter(function(f){ return f.session===selSess && f.term===selTerm; });

  // ── Attendance stats ──────────────────────────────
  var totalDays = termAttendance.length;
  var presentDays = termAttendance.filter(function(a){ return a.present; }).length;
  var absentDays = totalDays - presentDays;
  var attPct = totalDays ? Math.round((presentDays/totalDays)*100) : 0;

  // ── Results summary ───────────────────────────────
  var totalScore = termResults.reduce(function(a,r){ return a+r.total; }, 0);
  var avgScore = termResults.length ? (totalScore/termResults.length).toFixed(1) : null;
  var highest = termResults.length ? Math.max.apply(null, termResults.map(function(r){return r.total;})) : null;
  var lowest = termResults.length ? Math.min.apply(null, termResults.map(function(r){return r.total;})) : null;
  var passed = termResults.filter(function(r){ return r.total>=rc.passMark; }).length;

  // ── Fees summary ──────────────────────────────────
  var totalFeesBilled = termFees.reduce(function(a,f){ return a+(f.amount||0); }, 0);
  var totalFeesPaid = termFees.reduce(function(a,f){ return a+(f.paid||0); }, 0);
  var feeBalance = totalFeesBilled - totalFeesPaid;
  var feePct = totalFeesBilled ? Math.round((totalFeesPaid/totalFeesBilled)*100) : 0;

  // ── Recent school notices from diary ─────────────
  var notices = diary.filter(function(d){
    return d.category !== "Discipline";
  }).sort(function(a,b){ return b.date.localeCompare(a.date); }).slice(0,8);

  var NAV_TABS = [
    ["home","🏠 Home"],["results","📝 Results"],
    ["attendance","📋 Attendance"],["fees","💰 Fees"],
    ["lessons","📖 Lesson Notes"],["assignments","📝 Assignments"],
    ["cbt","🖥 CBT Exams"],
    ["notices","📢 Notices"],["library","📚 Library"],["gallery","🖼 Gallery"],
  ];

  // ── Lesson notes & assignments (read-only for parents) ──
  var classLessons = (lessons||[]).filter(function(l){ return l.class === student.class; });
  // Only class-wide assignments, or ones specifically targeted to this child
  // (see the "assign remedial work" tool in Results — Score Entry).
  var classAssignments = (assignments||[]).filter(function(a){ return a.class === student.class && (!a.targetStudentIds || a.targetStudentIds.length===0 || a.targetStudentIds.includes(student.id)); });
  function childSubmission(assignmentId){
    return (submissions||[]).find(function(s){ return s.assignmentId===assignmentId && s.studentId===student.id; });
  }

  // ── CBT exams (online, anti-cheat monitored) ──────────
  function callExamApi(action, extra){
    return fetch("/api/exam", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+parentToken},
      body:JSON.stringify(Object.assign({action:action}, extra||{}))
    }).then(function(r){ return r.json(); });
  }

  function startExam(examId){
    setLoadingExam(true);
    callExamApi("start",{examId:examId}).then(function(res){
      setLoadingExam(false);
      if(res.error) return alert(res.error);
      setActiveAttempt({
        attemptId:res.attemptId, questions:res.questions, answers:res.answers||{},
        startedAt:res.startedAt, effectiveDurationMinutes:res.effectiveDurationMinutes,
        examTitle:res.examTitle, examSubject:res.examSubject
      });
    }).catch(function(e){ setLoadingExam(false); alert("Could not start exam: "+e.message); });
  }

  function selectAnswer(questionId, value){
    var attemptId = activeAttempt.attemptId;
    setActiveAttempt(function(p){ return Object.assign({}, p, {answers:Object.assign({}, p.answers, {[questionId]:value})}); });
    callExamApi("answer",{attemptId:attemptId, questionId:questionId, value:value}).catch(function(){});
  }

  function submitExam(){
    if(!activeAttempt) return;
    var title = activeAttempt.examTitle, subject = activeAttempt.examSubject;
    var attemptId = activeAttempt.attemptId;
    setActiveAttempt(null);
    callExamApi("submit",{attemptId:attemptId}).then(function(res){
      if(res.error) return alert(res.error);
      setExamResult(Object.assign({}, res, {examTitle:title, examSubject:subject}));
    }).catch(function(e){ alert("Could not submit exam: "+e.message); });
  }

  // Anti-cheat monitoring — active only while a CBT attempt is in progress.
  // A determined student with a second device can still cheat; this is a
  // deterrent that logs flags for teacher review, not an absolute block.
  useEffect(function(){
    if(!activeAttempt) return;
    function blockCopyPaste(e){
      e.preventDefault();
      callExamApi("flag",{attemptId:activeAttempt.attemptId, field:"pasteAttemptCount"}).catch(function(){});
    }
    function blockContextMenu(e){ e.preventDefault(); }
    function handleVisibility(){
      if(document.hidden) callExamApi("flag",{attemptId:activeAttempt.attemptId, field:"tabSwitchCount"}).catch(function(){});
    }
    document.addEventListener("copy", blockCopyPaste);
    document.addEventListener("paste", blockCopyPaste);
    document.addEventListener("cut", blockCopyPaste);
    document.addEventListener("contextmenu", blockContextMenu);
    document.addEventListener("visibilitychange", handleVisibility);
    return function(){
      document.removeEventListener("copy", blockCopyPaste);
      document.removeEventListener("paste", blockCopyPaste);
      document.removeEventListener("cut", blockCopyPaste);
      document.removeEventListener("contextmenu", blockContextMenu);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  },[activeAttempt&&activeAttempt.attemptId]);

  // Countdown timer — auto-submits when time runs out.
  useEffect(function(){
    if(!activeAttempt){ setRemainingSec(null); return; }
    function tick(){
      var elapsed = (Date.now()-new Date(activeAttempt.startedAt).getTime())/1000;
      var total = activeAttempt.effectiveDurationMinutes*60;
      var rem = Math.max(0, Math.round(total-elapsed));
      setRemainingSec(rem);
      if(rem<=0) submitExam();
    }
    tick();
    var iv = setInterval(tick, 1000);
    return function(){ clearInterval(iv); };
  },[activeAttempt&&activeAttempt.attemptId]);

  var CAT_COLOR = {A1:"green",B2:"green",B3:"green",C4:"yellow",C5:"yellow",C6:"yellow",D7:"red",E8:"red",F9:"red"};

  function renderHome(){
    return(
      <div>
        {/* Child profile card */}
        <div style={{background:"linear-gradient(120deg,#230E6A,#3D2496)",borderRadius:14,padding:"20px 24px",marginBottom:16,color:"#fff",display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{width:70,height:70,borderRadius:"50%",overflow:"hidden",border:"3px solid #F0C060",flexShrink:0,background:"rgba(255,255,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            {student.passport ? <img src={student.passport} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : <span style={{fontSize:28}}>👦</span>}
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:18,fontWeight:900,color:"#F0C060"}}>{student.firstname} {student.surname}</div>
            <div style={{fontSize:12,opacity:0.85,marginTop:2}}>{student.class}{student.arm} · Admission: {student.admissionNo}</div>
            <div style={{display:"flex",gap:12,marginTop:6,flexWrap:"wrap"}}>
              <span style={{fontSize:11,opacity:0.8}}>📚 {student.boardingType||"Day"} Student</span>
              <span style={{fontSize:11,opacity:0.8}}>🩸 {student.bloodGroup||"—"} · {student.genotype||"—"}</span>
              <span style={{fontSize:11,opacity:0.8}}>📅 {CURRENT_TERM} {CURRENT_SESSION}</span>
            </div>
          </div>
          {logo ? <img src={logo} alt="" style={{width:50,height:50,objectFit:"contain",opacity:0.8}}/> : null}
        </div>

        <SchoolCalendarWidget settings={settings}/>

        {/* Quick stats */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:12,marginBottom:16}}>
          {[
            {l:"Average Score",v:avgScore||"—",sub:termResults.length+" subjects",bg:"#EFF6FF",color:"#1D4ED8"},
            {l:"Attendance",v:attPct+"%",sub:presentDays+"/"+totalDays+" days",bg:"#F0FDF4",color:"#059669"},
            {l:"Fees Paid",v:feePct+"%",sub:"₦"+totalFeesPaid.toLocaleString()+" of ₦"+totalFeesBilled.toLocaleString(),bg:feePct===100?"#F0FDF4":"#FFF7ED",color:feePct===100?"#059669":"#D97706"},
            {l:"Subjects Passed",v:passed+"/"+termResults.length,sub:termResults.length?"out of "+termResults.length+" subjects":"No results yet",bg:"#F5F3FB",color:"#230E6A"},
          ].map(function(s,i){
            return(
              <div key={i} style={{background:s.bg,borderRadius:10,padding:"14px 12px",textAlign:"center",border:"1px solid "+s.bg}}>
                <div style={{fontSize:22,fontWeight:900,color:s.color}}>{s.v}</div>
                <div style={{fontSize:11,fontWeight:700,color:"#374151",marginTop:2}}>{s.l}</div>
                <div style={{fontSize:10,color:"#6B7280",marginTop:2}}>{s.sub}</div>
              </div>
            );
          })}
        </div>

        {/* Term selector */}
        <div style={{...S.card,marginBottom:14}}>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#230E6A"}}>Viewing data for:</div>
            <select style={S.select} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>
              {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
            </select>
            <select style={S.select} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>
              {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
            </select>
          </div>
        </div>

        {/* Fee alert */}
        {feeBalance > 0 ? (
          <div style={{background:"#FEF3C7",border:"2px solid #F59E0B",borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:"#92400E"}}>⚠️ Outstanding Fee Balance</div>
              <div style={{fontSize:12,color:"#78350F",marginTop:2}}>₦{feeBalance.toLocaleString()} remaining for {selTerm} {selSess}</div>
            </div>
            <button onClick={function(){setTab("fees");}} style={{...S.btn("yellow"),fontSize:12}}>View Fees →</button>
          </div>
        ) : null}

        {/* Latest notices */}
        <div style={S.card}>
          <div style={{...S.row,justifyContent:"space-between",marginBottom:10}}>
            <div style={S.cardTitle}>📢 Latest School Notices</div>
            <button onClick={function(){setTab("notices");}} style={{...S.btn("ghost"),fontSize:11}}>View All</button>
          </div>
          {notices.slice(0,3).map(function(n,i){
            return(
              <div key={i} style={{padding:"9px 0",borderBottom:"1px solid "+C.border,display:"flex",gap:10}}>
                <div style={{fontSize:11,fontWeight:700,color:"#230E6A",minWidth:80}}>{formatDate(n.date)}</div>
                <div style={{fontSize:12,color:"#374151",lineHeight:1.4}}>{n.event}</div>
              </div>
            );
          })}
          {notices.length===0 ? <div style={{textAlign:"center",color:C.textMuted,padding:16,fontSize:12}}>No notices at this time.</div> : null}
        </div>
      </div>
    );
  }

  function renderResults(){
    return(
      <div>
        <div style={{...S.row,marginBottom:12,flexWrap:"wrap",gap:8}}>
          <select style={S.select} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>
            {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
          </select>
          <select style={S.select} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>
            {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
          </select>
        </div>

        {termResults.length===0 ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
            <div style={{fontSize:32,marginBottom:8}}>📝</div>
            <div style={{fontSize:13,fontWeight:600}}>No results available yet</div>
            <div style={{fontSize:12,marginTop:4}}>Results for {selTerm} {selSess} will appear here once published by your school.</div>
          </div>
        ) : (
          <div>
            <div style={S.statsGrid}>
              {[
                {l:"Average",v:avgScore+"%",bg:"#EFF6FF"},{l:"Highest",v:highest+"%",bg:"#F0FDF4"},
                {l:"Lowest",v:lowest+"%",bg:"#FEF2F2"},{l:"Passed",v:passed+"/"+termResults.length,bg:"#F5F3FB"},
              ].map(function(s,i){return(
                <div key={i} style={S.statCard(s.bg)}><div style={S.statNum}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>
              );})}
            </div>

            <div style={S.card}>
              <div style={S.cardTitle}>{selTerm} {selSess} — Subject Results</div>
              <table style={S.table}>
                <thead><tr>{["Subject","CA1","CA2","Exam","Total","Grade","Remark"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
                <tbody>
                  {termResults.sort(function(a,b){return b.total-a.total;}).map(function(r){
                    var g = getGrade(r.total, settings);
                    return(
                      <tr key={r.id}>
                        <td style={{...S.td,fontWeight:600}}>{r.subject}</td>
                        <td style={S.tdC}>{r.ca1||"—"}</td>
                        <td style={S.tdC}>{r.ca2||"—"}</td>
                        <td style={S.tdC}>{r.exam||"—"}</td>
                        <td style={{...S.tdC,fontWeight:700,fontSize:13,color:r.total>=rc.passMark?"#059669":"#DC2626"}}>{r.total}</td>
                        <td style={S.tdC}><span style={S.badge(CAT_COLOR[g.grade]||"yellow")}>{g.grade}</span></td>
                        <td style={{...S.td,fontSize:11,color:r.total>=70?"#059669":r.total>=50?"#D97706":"#DC2626"}}>{g.remark}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{background:"#F5F3FB"}}>
                    <td style={{...S.td,fontWeight:700}} colSpan={4}>AVERAGE</td>
                    <td style={{...S.tdC,fontWeight:900,color:"#230E6A",fontSize:14}}>{avgScore}</td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* All-time results history */}
            <div style={{...S.card,marginTop:14}}>
              <div style={S.cardTitle}>📈 Performance History</div>
              {SESSIONS.map(function(sess){
                return TERMS.map(function(t){
                  var tRes = childResults.filter(function(r){return r.session===sess&&r.term===t;});
                  if(!tRes.length) return null;
                  var tavg = (tRes.reduce(function(a,r){return a+r.total;},0)/tRes.length).toFixed(1);
                  return(
                    <div key={sess+t} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid "+C.border,fontSize:12}}>
                      <span style={{fontWeight:600}}>{t} · {sess}</span>
                      <span style={{color:parseFloat(tavg)>=50?"#059669":"#DC2626",fontWeight:700}}>{tavg}% avg · {tRes.length} subjects</span>
                    </div>
                  );
                });
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderAttendance(){
    var termDates = [...new Set(termAttendance.map(function(a){return a.date;}))].sort().reverse();
    return(
      <div>
        <div style={{...S.row,marginBottom:12,flexWrap:"wrap",gap:8}}>
          <select style={S.select} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>
            {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
          </select>
          <select style={S.select} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>
            {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
          </select>
        </div>

        <div style={S.statsGrid}>
          {[
            {l:"Days Present",v:presentDays,bg:"#F0FDF4"},{l:"Days Absent",v:absentDays,bg:"#FEF2F2"},
            {l:"Total Days",v:totalDays,bg:"#EFF6FF"},{l:"Attendance Rate",v:attPct+"%",bg:attPct>=80?"#F0FDF4":"#FEF2F2"},
          ].map(function(s,i){return(
            <div key={i} style={S.statCard(s.bg)}><div style={S.statNum}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>
          );})}
        </div>

        {/* Visual attendance bar */}
        <div style={{...S.card,marginBottom:14}}>
          <div style={S.cardTitle}>Attendance Rate — {selTerm} {selSess}</div>
          <div style={{height:20,background:"#F3F4F6",borderRadius:10,overflow:"hidden",marginBottom:8}}>
            <div style={{height:"100%",width:attPct+"%",background:attPct>=80?"#059669":attPct>=60?"#D97706":"#DC2626",borderRadius:10,transition:"width 0.5s"}}/>
          </div>
          <div style={{fontSize:12,color:C.textMuted}}>{attPct>=80?"✅ Excellent attendance":"⚠️ Attendance needs improvement — minimum 80% required"}</div>
        </div>

        {totalDays===0 ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No attendance records for {selTerm} {selSess} yet.</div>
        ) : (
          <div style={S.card}>
            <div style={S.cardTitle}>Daily Record</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:8}}>
              {termDates.map(function(date){
                var rec = termAttendance.find(function(a){return a.date===date;});
                var present = rec && rec.present;
                return(
                  <div key={date} title={formatDate(date)+" — "+(present?"Present":"Absent")} style={{padding:"4px 10px",borderRadius:6,background:present?"#D1FAE5":"#FEE2E2",color:present?"#065F46":"#991B1B",fontSize:10,fontWeight:600}}>
                    {date.slice(5).replace("-","/")} {present?"✓":"✗"}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderFees(){
    return(
      <div>
        <div style={{...S.row,marginBottom:12,flexWrap:"wrap",gap:8}}>
          <select style={S.select} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>
            {TERMS.map(function(t){return <option key={t}>{t}</option>;})}
          </select>
          <select style={S.select} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>
            {SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}
          </select>
        </div>

        {/* Fee status card */}
        <div style={{background:feeBalance===0?"linear-gradient(120deg,#059669,#047857)":"linear-gradient(120deg,#D97706,#B45309)",borderRadius:12,padding:"20px 24px",marginBottom:16,color:"#fff"}}>
          <div style={{fontSize:13,opacity:0.85,marginBottom:4}}>{selTerm} {selSess} Fee Status</div>
          <div style={{fontSize:26,fontWeight:900}}>{feeBalance===0?"✅ Fully Paid":"⚠️ Balance: ₦"+feeBalance.toLocaleString()}</div>
          <div style={{display:"flex",gap:20,marginTop:10,flexWrap:"wrap"}}>
            <div><div style={{fontSize:10,opacity:0.7}}>TOTAL BILLED</div><div style={{fontSize:14,fontWeight:700}}>₦{totalFeesBilled.toLocaleString()}</div></div>
            <div><div style={{fontSize:10,opacity:0.7}}>TOTAL PAID</div><div style={{fontSize:14,fontWeight:700}}>₦{totalFeesPaid.toLocaleString()}</div></div>
            <div><div style={{fontSize:10,opacity:0.7}}>BALANCE</div><div style={{fontSize:14,fontWeight:700}}>₦{feeBalance.toLocaleString()}</div></div>
          </div>
        </div>

        {termFees.length===0 ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No fee records for {selTerm} {selSess} yet.</div>
        ) : (
          <div style={S.card}>
            <div style={S.cardTitle}>Payment History</div>
            <table style={S.table}>
              <thead><tr>{["Date","Description","Amount","Paid","Balance","Status"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}</tr></thead>
              <tbody>
                {termFees.map(function(f){
                  var bal = (f.amount||0)-(f.paid||0);
                  return(
                    <tr key={f.id}>
                      <td style={S.td}>{formatDate(f.date||f.paidDate||"")}</td>
                      <td style={S.td}>{f.description||f.feeType||"School Fees"}</td>
                      <td style={S.tdC}>₦{(f.amount||0).toLocaleString()}</td>
                      <td style={{...S.tdC,color:"#059669",fontWeight:700}}>₦{(f.paid||0).toLocaleString()}</td>
                      <td style={{...S.tdC,color:bal>0?"#DC2626":"#059669",fontWeight:700}}>₦{bal.toLocaleString()}</td>
                      <td style={S.td}><span style={S.badge(bal===0?"green":bal<(f.amount||0)?"yellow":"red")}>{bal===0?"Paid":bal<(f.amount||0)?"Partial":"Unpaid"}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* All sessions fee history */}
        {childFees.length > termFees.length ? (
          <div style={{...S.card,marginTop:14}}>
            <div style={S.cardTitle}>All-Time Payment History</div>
            {SESSIONS.map(function(sess){
              return TERMS.map(function(t){
                var sf = childFees.filter(function(f){return f.session===sess&&f.term===t;});
                if(!sf.length) return null;
                var paid = sf.reduce(function(a,f){return a+(f.paid||0);},0);
                var billed = sf.reduce(function(a,f){return a+(f.amount||0);},0);
                return(
                  <div key={sess+t} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid "+C.border,fontSize:12}}>
                    <span style={{fontWeight:600}}>{t} · {sess}</span>
                    <span style={{color:paid>=billed?"#059669":"#D97706",fontWeight:700}}>₦{paid.toLocaleString()} / ₦{billed.toLocaleString()} {paid>=billed?"✅":"⚠️"}</span>
                  </div>
                );
              });
            })}
          </div>
        ) : null}
      </div>
    );
  }

  function renderNotices(){
    var catColors = {General:"blue",Academic:"green",Sports:"yellow",Visitors:"blue","Event/Ceremony":"green",Logistics:"yellow",Health:"red",Emergency:"red",Others:"yellow"};
    return(
      <div>
        {notices.length===0 ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
            <div style={{fontSize:32,marginBottom:8}}>📭</div>
            <div style={{fontSize:13,fontWeight:600}}>No notices at this time</div>
          </div>
        ) : (
          <div>
            {notices.map(function(n,i){
              return(
                <div key={i} style={{...S.card,marginBottom:10}}>
                  <div style={{...S.row,justifyContent:"space-between",marginBottom:6}}>
                    <span style={S.badge(catColors[n.category]||"blue")}>{n.category}</span>
                    <span style={{fontSize:11,color:C.textMuted}}>{formatDate(n.date)} · {n.time}</span>
                  </div>
                  <div style={{fontSize:13,lineHeight:1.6,color:"#374151"}}>{n.event}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function renderLessons(){
    return(
      <div>
        {selLesson?(
          <div style={S.card}>
            <button style={{...S.btn("secondary"),fontSize:11,marginBottom:14}} onClick={function(){setSelLesson(null);}}>← Back to Lessons</button>
            <div style={{background:"#230E6A",borderRadius:8,padding:"14px 18px",marginBottom:16,color:"#fff"}}>
              <div style={{fontSize:15,fontWeight:800,color:"#F0C060"}}>{selLesson.topic}</div>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:4}}>{selLesson.subject} · {selLesson.class}{selLesson.arm||""} · {formatDate(selLesson.date)}</div>
            </div>
            {selLesson.subtopic&&<div style={{...S.card,background:"#EFF6FF",marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:"#1D4ED8",marginBottom:4}}>📌 SUBTOPIC</div><div style={{fontSize:13}}>{selLesson.subtopic}</div></div>}
            {selLesson.behaviouralObjectives&&<div style={{...S.card,background:"#F0FDF4",marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:"#059669",marginBottom:6}}>🎯 LEARNING OBJECTIVES</div><div style={{fontSize:13,lineHeight:1.8,whiteSpace:"pre-line"}}>{selLesson.behaviouralObjectives}</div></div>}
            {selLesson.keyPoints&&<div style={{...S.card,background:"#FFF7ED",marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:"#D97706",marginBottom:6}}>🔑 KEY POINTS / KEYWORDS</div><div style={{fontSize:13,lineHeight:1.8,whiteSpace:"pre-line"}}>{selLesson.keyPoints}</div></div>}
            {selLesson.previousKnowledge&&<div style={{...S.card,marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:"#6B7280",marginBottom:4}}>📚 PRIOR KNOWLEDGE NEEDED</div><div style={{fontSize:13}}>{selLesson.previousKnowledge}</div></div>}
            {(selLesson.videoLinks||[]).length>0&&(
              <div style={{marginBottom:14}}>
                <div style={{fontSize:11,fontWeight:700,color:"#230E6A",marginBottom:10}}>🎬 VIDEO RESOURCES</div>
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  {selLesson.videoLinks.map(function(v,i){
                    var embed = v.url&&v.url.includes("youtube")?v.url.replace("watch?v=","embed/").replace("youtu.be/","www.youtube.com/embed/"):null;
                    return(
                      <div key={i} style={{borderRadius:8,overflow:"hidden",border:"2px solid #E5E7EB"}}>
                        <div style={{background:"#230E6A",padding:"8px 12px",color:"#F0C060",fontWeight:600,fontSize:12}}>▶ {v.title}</div>
                        {embed?(<iframe width="100%" height="240" src={embed} title={v.title} frameBorder="0" allowFullScreen style={{display:"block"}}/>):(<a href={v.url} target="_blank" rel="noopener noreferrer" style={{display:"block",padding:"12px",background:"#FEE2E2",color:"#DC2626",fontWeight:600,fontSize:12}}>🔗 Open Video Link: {v.url}</a>)}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {selLesson.assignment&&<div style={{background:"#FFFBEB",border:"1px solid #F59E0B",borderRadius:8,padding:"12px 16px",marginBottom:14}}><div style={{fontSize:10,fontWeight:700,color:"#D97706",marginBottom:4}}>📝 ASSIGNMENT</div><div style={{fontSize:13,lineHeight:1.6}}>{selLesson.assignment}</div><div style={{fontSize:11,color:"#6B7280",marginTop:6}}>See the Assignments tab for submission status.</div></div>}
          </div>
        ):(
          <div>
            <div style={{background:"linear-gradient(120deg,#230E6A,#3D2496)",borderRadius:12,padding:"16px 20px",marginBottom:14,color:"#fff"}}>
              <div style={{fontSize:16,fontWeight:800}}>📖 Lesson Notes</div>
              <div style={{fontSize:11,opacity:0.8,marginTop:2}}>Published lessons for {student.class}{student.arm}</div>
            </div>
            {classLessons.length===0&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No published lessons for {student.class} yet.</div>}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
              {classLessons.map(function(l){
                var hasVideo = (l.videoLinks||[]).length>0;
                return(
                  <div key={l.id} onClick={function(){setSelLesson(l);}} style={{...S.card,cursor:"pointer",borderLeft:"4px solid #230E6A",margin:0}}>
                    <div style={{fontSize:13,fontWeight:700,color:"#230E6A",marginBottom:4}}>{l.topic}</div>
                    <div style={{fontSize:11,color:C.textMuted,marginBottom:6}}>{l.subject} · {formatDate(l.date)}</div>
                    {l.subtopic&&<div style={{fontSize:11,color:C.textMuted,fontStyle:"italic",marginBottom:6}}>{l.subtopic}</div>}
                    <div style={S.row}>
                      {hasVideo&&<span style={S.badge("red")}>▶ {l.videoLinks.length} Video{l.videoLinks.length>1?"s":""}</span>}
                      {l.assignment&&<span style={S.badge("yellow")}>📝 Has Assignment</span>}
                      <span style={{...S.badge("green"),marginLeft:"auto"}}>Open →</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderAssignments(){
    return(
      <div>
        <div style={{background:"linear-gradient(120deg,#230E6A,#3D2496)",borderRadius:12,padding:"16px 20px",marginBottom:14,color:"#fff"}}>
          <div style={{fontSize:16,fontWeight:800}}>📝 Assignments</div>
          <div style={{fontSize:11,opacity:0.8,marginTop:2}}>Assignments for {student.class}{student.arm}</div>
        </div>
        {classAssignments.length===0&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No assignments for {student.class}.</div>}
        {classAssignments.map(function(asn){
          var sub = childSubmission(asn.id);
          var lesson = (lessons||[]).find(function(l){ return l.id===asn.lessonId; });
          var open = lesson ? lesson.submissionOpen!==false : asn.status!=="Closed";
          return(
            <div key={asn.id} style={S.card}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
                <div style={{flex:1}}>
                  <div style={S.row}>
                    <div style={{fontSize:14,fontWeight:700,color:"#230E6A"}}>{asn.title}</div>
                    <span style={S.badge(open?"green":"red")}>{open?"🟢 Open":"🔒 Closed"}</span>
                  </div>
                  <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{asn.subject} · Due: {asn.dueDate?formatDate(asn.dueDate):"Open"} · Max: {asn.maxScore} marks</div>
                  <div style={{fontSize:12,color:C.text,marginTop:8,lineHeight:1.6}}>{asn.description}</div>
                </div>
              </div>
              {sub?(
                <div style={{marginTop:12,background:sub.marked?"#F0FDF4":"#FFFBEB",border:"1px solid "+(sub.marked?"#059669":"#F0C060"),borderRadius:8,padding:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:sub.marked?"#059669":"#D97706",marginBottom:6}}>{sub.marked?"✓ Marked":"⏳ Submitted — Awaiting Marking"}</div>
                  <div style={{fontSize:12,color:C.text,lineHeight:1.6,marginBottom:sub.marked?8:0}}>{sub.content}</div>
                  {sub.marked&&<>
                    <div style={{fontWeight:700,fontSize:14,color:"#059669"}}>Score: {sub.score}/{asn.maxScore}</div>
                    {sub.feedback&&<div style={{fontSize:12,color:"#230E6A",marginTop:6,fontStyle:"italic"}}>Teacher's comment: "{sub.feedback}"</div>}
                  </>}
                </div>
              ):open?(
                submittingAsn===asn.id?(
                  <div style={{marginTop:12,background:"#F5F3FB",border:"1px solid "+C.border,borderRadius:8,padding:12}}>
                    <label style={{...S.label,marginBottom:6}}>Your Answer:</label>
                    <textarea style={{...S.textarea,minHeight:100}} value={submissionText} onChange={function(e){setSubmissionText(e.target.value);}} placeholder="Type your child's answer here..."/>
                    <div style={{...S.row,marginTop:10,gap:8}}>
                      <button style={S.btn()} disabled={submitBusy} onClick={function(){submitAssignmentAnswer(asn.id);}}>{submitBusy?"Submitting...":"Submit"}</button>
                      <button style={S.btn("secondary")} onClick={function(){setSubmittingAsn(null);setSubmissionText("");}}>Cancel</button>
                    </div>
                  </div>
                ):(
                  <button style={{...S.btn(),marginTop:12,fontSize:11}} onClick={function(){setSubmittingAsn(asn.id);setSubmissionText("");}}>📝 Submit Assignment</button>
                )
              ):(
                <div style={{marginTop:12,background:"#FEE2E2",border:"1px solid "+C.danger,borderRadius:8,padding:10,fontSize:12,color:C.danger,fontWeight:600}}>
                  🔒 Submissions for this assignment have been closed by the teacher. You missed the deadline.
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function renderCbtList(){
    var available = exams||[];
    return(
      <div>
        <div style={{background:"linear-gradient(120deg,#230E6A,#3D2496)",borderRadius:12,padding:"16px 20px",marginBottom:14,color:"#fff"}}>
          <div style={{fontSize:16,fontWeight:800}}>🖥 CBT Exams</div>
          <div style={{fontSize:11,opacity:0.8,marginTop:2}}>Online exams available for {student.class}{student.arm}</div>
        </div>
        <div style={{...S.card,background:"#FFFBEB",border:"1px solid #F59E0B",marginBottom:14,fontSize:11,color:"#92400E"}}>
          ⚠ Once started, the timer cannot be paused. Find a quiet spot with a stable connection before you begin. Tab switches, copy/paste and right-click are logged during the exam.
        </div>
        {available.length===0&&<div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No CBT exams available right now.</div>}
        {available.map(function(e){
          return(
            <div key={e.id} style={S.card}>
              <div style={{fontSize:14,fontWeight:700,color:"#230E6A"}}>{e.title}</div>
              <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{e.subject} · ⏱ {e.duration} minutes{(student.examExtraMinutes>0)?" (+"+student.examExtraMinutes+" min accommodation)":""}</div>
              <button style={{...S.btn(),marginTop:10,fontSize:12}} disabled={loadingExam} onClick={function(){startExam(e.id);}}>{loadingExam?"Loading...":"▶ Start / Resume Exam"}</button>
            </div>
          );
        })}
      </div>
    );
  }

  function renderCbtTaking(){
    var a = activeAttempt;
    var mins = Math.floor((remainingSec||0)/60);
    var secs = (remainingSec||0)%60;
    var answeredCount = Object.keys(a.answers||{}).length;
    var low = (remainingSec!==null&&remainingSec<=60);
    return(
      <div>
        <div style={{background:low?"#DC2626":"#230E6A",borderRadius:12,padding:"14px 20px",marginBottom:14,color:"#fff",position:"sticky",top:66,zIndex:50,boxShadow:"0 2px 10px rgba(0,0,0,0.2)"}}>
          <div style={{fontSize:13,fontWeight:700,color:"#F0C060"}}>{a.examTitle} · {a.examSubject}</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:6}}>
            <div style={{fontSize:24,fontWeight:900}}>⏱ {String(mins).padStart(2,"0")}:{String(secs).padStart(2,"0")}</div>
            <div style={{fontSize:12}}>{answeredCount} / {a.questions.length} answered</div>
          </div>
        </div>
        {a.questions.map(function(q,i){
          return(
            <div key={q.id} style={S.card}>
              <div style={{fontWeight:700,marginBottom:8,display:"flex",justifyContent:"space-between",gap:8}}>
                <span>{i+1}. {q.text}</span>
                <span style={{fontSize:11,color:C.textMuted,whiteSpace:"nowrap"}}>[{q.marks} marks]</span>
              </div>
              {q.image?<img src={q.image} alt="" style={{maxWidth:"100%",marginBottom:8,borderRadius:6}}/>:null}
              {["A","B","C","D"].map(function(letter){
                var opt = q["option"+letter];
                if(!opt) return null;
                var selected = a.answers[q.id]===letter;
                return(
                  <label key={letter} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:6,marginBottom:6,background:selected?"#EFF6FF":"#F9FAFB",border:"1px solid "+(selected?"#230E6A":"#E5E7EB"),cursor:"pointer"}}>
                    <input type="radio" name={"q_"+q.id} checked={selected} onChange={function(){selectAnswer(q.id, letter);}}/>
                    <span style={{fontWeight:700}}>{letter}.</span>
                    <span>{opt}</span>
                  </label>
                );
              })}
            </div>
          );
        })}
        <button style={{...S.btn("green"),width:"100%",fontSize:14,padding:14}} onClick={function(){ if(window.confirm("Submit your answers now? You cannot change them after submitting.")) submitExam(); }}>✅ Submit Exam</button>
      </div>
    );
  }

  function renderCbtResult(){
    var r = examResult;
    return(
      <div style={{...S.card,textAlign:"center",padding:32}}>
        <div style={{fontSize:40,marginBottom:10}}>{r.autoPushed?"✅":"📝"}</div>
        <div style={{fontSize:16,fontWeight:800,marginBottom:6,color:"#230E6A"}}>{r.examTitle} Submitted!</div>
        <div style={{fontSize:28,fontWeight:900,color:"#059669",marginBottom:4}}>{r.correctCount}/{r.totalCount} correct</div>
        <div style={{fontSize:13,color:C.textMuted,marginBottom:14}}>Score: {r.score} / {r.maxScore}</div>
        <div style={{fontSize:12,color:C.textMuted,maxWidth:400,margin:"0 auto"}}>
          {r.autoPushed ? "Your score has been recorded." : "Objective answers recorded — your teacher will complete manual marking of any theory questions before your final score is confirmed."}
        </div>
        <button style={{...S.btn(),marginTop:16}} onClick={function(){setExamResult(null);}}>Back to Exams</button>
      </div>
    );
  }

  function renderCbt(){
    if(activeAttempt) return renderCbtTaking();
    if(examResult) return renderCbtResult();
    return renderCbtList();
  }

  function renderLibrary(){
    return(
      <div>
        <div style={{background:"linear-gradient(120deg,#230E6A,#059669)",borderRadius:12,padding:"16px 20px",marginBottom:14,color:"#fff"}}>
          <div style={{fontSize:16,fontWeight:800}}>📚 E-Library</div>
          <div style={{fontSize:11,opacity:0.8,marginTop:2}}>Open access — all {elibrary.length} resources available to you</div>
        </div>
        {elibrary.length===0 ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>Library is empty. Check back soon.</div>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
            {elibrary.map(function(book){
              return(
                <div key={book.id} style={{...S.card,margin:0}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#230E6A",marginBottom:4}}>{book.title}</div>
                  <div style={{fontSize:11,color:C.textMuted,marginBottom:6}}>{book.author}</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                    <span style={S.badge("blue")}>{book.category}</span>
                    {book.subject ? <span style={S.badge("green")}>{book.subject}</span> : null}
                  </div>
                  <button onClick={function(){
                    if(book.type==="pdf"&&book.file){ window.open(book.file,"_blank"); }
                    else if(book.url){ window.open(book.url,"_blank"); }
                  }} style={{...S.btn("blue"),fontSize:11,width:"100%"}}>
                    {book.type==="pdf"?"📄 Read PDF":"🔗 Open Resource"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function renderGallery(){
    return(
      <div>
        <div style={{background:"linear-gradient(120deg,#230E6A,#059669)",borderRadius:12,padding:"16px 20px",marginBottom:14,color:"#fff"}}>
          <div style={{fontSize:16,fontWeight:800}}>🖼 School Gallery</div>
          <div style={{fontSize:11,opacity:0.8,marginTop:2}}>Photos from school events — view only</div>
        </div>
        <GalleryModule gallery={gallery||[]} setGallery={function(){}} currentUser={{name:student.parentName||"Parent"}} readOnly={true}/>
      </div>
    );
  }

  return(
    <div style={{minHeight:"100vh",background:"#F9FAFB",fontFamily:"'Segoe UI',sans-serif"}}>
      {/* Top bar */}
      <div style={{background:"linear-gradient(90deg,#230E6A,#3D2496)",padding:"0 20px",display:"flex",alignItems:"center",justifyContent:"space-between",height:56,position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          {logo ? <img src={logo} alt="" style={{width:32,height:32,objectFit:"contain"}}/> : null}
          <div>
            <div style={{fontSize:12,fontWeight:800,color:"#F0C060"}}>{SCHOOL_NAME}</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.6)"}}>Parent Portal</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:11,color:"rgba(255,255,255,0.8)"}}>👋 {student.parentName||"Parent"}</span>
          {!activeAttempt&&<button onClick={onLogout} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:6,color:"#fff",padding:"4px 12px",cursor:"pointer",fontSize:11}}>Logout</button>}
        </div>
      </div>

      {/* Tab navigation — hidden during an active CBT attempt so the timer can't be dodged by navigating away */}
      {!activeAttempt&&<div style={{background:"#fff",borderBottom:"1px solid #E5E7EB",padding:"0 20px",display:"flex",gap:0,overflowX:"auto"}}>
        {NAV_TABS.map(function(pair){
          var id=pair[0]; var label=pair[1];
          return(
            <button key={id} onClick={function(){setTab(id);}} style={{background:"none",border:"none",borderBottom:tab===id?"3px solid #230E6A":"3px solid transparent",color:tab===id?"#230E6A":"#6B7280",fontWeight:tab===id?700:400,padding:"14px 16px",cursor:"pointer",fontSize:12,whiteSpace:"nowrap",fontFamily:"inherit"}}>
              {label}
            </button>
          );
        })}
      </div>}

      {/* Content */}
      <div style={{maxWidth:900,margin:"0 auto",padding:"20px 16px"}}>
        {tab==="home" ? renderHome() : null}
        {tab==="results" ? renderResults() : null}
        {tab==="attendance" ? renderAttendance() : null}
        {tab==="fees" ? renderFees() : null}
        {tab==="lessons" ? renderLessons() : null}
        {tab==="assignments" ? renderAssignments() : null}
        {tab==="cbt" ? renderCbt() : null}
        {tab==="notices" ? renderNotices() : null}
        {tab==="library" ? renderLibrary() : null}
        {tab==="gallery" ? renderGallery() : null}
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════════════
// ITEM 14: PAYROLL & STAFF FINANCE
// ══════════════════════════════════════════════════════
function PayrollModule({staff, settings, currentUser}){
  var _tab = useState("payroll"); var tab = _tab[0]; var setTab = _tab[1];
  var _selMonth = useState(new Date().toISOString().slice(0,7)); var selMonth = _selMonth[0]; var setSelMonth = _selMonth[1];
  var _payrollData = useState({}); var payrollData = _payrollData[0]; var setPayrollData = _payrollData[1];
  var _showSlip = useState(null); var showSlip = _showSlip[0]; var setShowSlip = _showSlip[1];

  var ALLOWANCES = ["Housing Allowance","Transport Allowance","Meal Allowance","Leave Allowance"];
  var DEDUCTIONS = ["Tax (PAYE)","Pension (8%)","Cooperative Levy","Late Deduction","Loan Repayment"];

  function getPayData(staffId){
    var key = staffId+"_"+selMonth;
    return payrollData[key] || {
      basicSalary:"", housingAllowance:"", transportAllowance:"", mealAllowance:"", leaveAllowance:"",
      taxPAYE:"", pension:"", cooperative:"", lateDeduction:"", loanRepayment:"", notes:""
    };
  }

  function updatePayData(staffId, field, value){
    var key = staffId+"_"+selMonth;
    setPayrollData(function(p){
      var current = p[key] || getPayData(staffId);
      return {...p, [key]:{...current,[field]:value}};
    });
  }

  function calcNet(d){
    var basic = parseFloat(d.basicSalary)||0;
    var allws = (parseFloat(d.housingAllowance)||0)+(parseFloat(d.transportAllowance)||0)+(parseFloat(d.mealAllowance)||0)+(parseFloat(d.leaveAllowance)||0);
    var gross = basic + allws;
    var deds = (parseFloat(d.taxPAYE)||0)+(parseFloat(d.pension)||0)+(parseFloat(d.cooperative)||0)+(parseFloat(d.lateDeduction)||0)+(parseFloat(d.loanRepayment)||0);
    return {gross, deds, net:gross-deds};
  }

  function printPayslip(s){
    var d = getPayData(s.id);
    var c = calcNet(d);
    var hdr = buildDocHeader(settings, "PAYSLIP — "+selMonth);
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Payslip</title><style>'+hdr.printStyles+'.green{color:#059669;font-weight:700;}.red{color:#DC2626;font-weight:700;}</style></head><body>'+hdr.headerHtml+
      '<table style="margin-bottom:12px;"><tr><td><b>Name:</b> '+s.surname+' '+s.firstname+'</td><td><b>Role:</b> '+(s.role||"Staff")+'</td></tr><tr><td><b>Month:</b> '+selMonth+'</td><td><b>Staff ID:</b> STAFF/'+String(s.id).slice(-4).toUpperCase()+'</td></tr></table>'+
      '<table><thead><tr><th>Description</th><th style="text-align:right">Amount (₦)</th></tr></thead><tbody>'+
      '<tr><td>Basic Salary</td><td style="text-align:right">'+(d.basicSalary||0).toLocaleString()+'</td></tr>'+
      (d.housingAllowance?'<tr><td>Housing Allowance</td><td style="text-align:right">'+parseFloat(d.housingAllowance).toLocaleString()+'</td></tr>':'')+
      (d.transportAllowance?'<tr><td>Transport Allowance</td><td style="text-align:right">'+parseFloat(d.transportAllowance).toLocaleString()+'</td></tr>':'')+
      (d.mealAllowance?'<tr><td>Meal Allowance</td><td style="text-align:right">'+parseFloat(d.mealAllowance).toLocaleString()+'</td></tr>':'')+
      (d.leaveAllowance?'<tr><td>Leave Allowance</td><td style="text-align:right">'+parseFloat(d.leaveAllowance).toLocaleString()+'</td></tr>':'')+
      '<tr style="background:#F0FDF4;font-weight:700;"><td>GROSS EARNINGS</td><td style="text-align:right;color:#059669;">'+c.gross.toLocaleString()+'</td></tr>'+
      (d.taxPAYE?'<tr><td>Tax (PAYE)</td><td style="text-align:right;color:#DC2626;">-'+parseFloat(d.taxPAYE).toLocaleString()+'</td></tr>':'')+
      (d.pension?'<tr><td>Pension (8%)</td><td style="text-align:right;color:#DC2626;">-'+parseFloat(d.pension).toLocaleString()+'</td></tr>':'')+
      (d.cooperative?'<tr><td>Cooperative Levy</td><td style="text-align:right;color:#DC2626;">-'+parseFloat(d.cooperative).toLocaleString()+'</td></tr>':'')+
      (d.lateDeduction?'<tr><td>Late Deduction</td><td style="text-align:right;color:#DC2626;">-'+parseFloat(d.lateDeduction).toLocaleString()+'</td></tr>':'')+
      (d.loanRepayment?'<tr><td>Loan Repayment</td><td style="text-align:right;color:#DC2626;">-'+parseFloat(d.loanRepayment).toLocaleString()+'</td></tr>':'')+
      '<tr style="background:#FEF2F2;font-weight:700;"><td>TOTAL DEDUCTIONS</td><td style="text-align:right;color:#DC2626;">-'+c.deds.toLocaleString()+'</td></tr>'+
      '<tr style="background:#230E6A;color:#fff;font-size:14px;font-weight:900;"><td>NET PAY</td><td style="text-align:right;">₦'+c.net.toLocaleString()+'</td></tr>'+
      '</tbody></table>'+hdr.footerHtml+'</body></html>';
    var w = window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.print();}
  }

  var monthTotals = staff.reduce(function(acc,s){
    var d = getPayData(s.id);
    var c = calcNet(d);
    return {gross:acc.gross+c.gross,deds:acc.deds+c.deds,net:acc.net+c.net};
  },{gross:0,deds:0,net:0});

  return(
    <div>
      <div style={{...S.card,marginBottom:14}}>
        <div style={{display:"flex",gap:10,alignItems:"center",justifyContent:"space-between",flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            <label style={S.label}>Payroll Month:</label>
            <input type="month" style={S.input} value={selMonth} onChange={function(e){setSelMonth(e.target.value);}}/>
          </div>
          <div style={{display:"flex",gap:10}}>
            {[{l:"Total Gross",v:"₦"+monthTotals.gross.toLocaleString(),bg:"#F0FDF4"},{l:"Total Deductions",v:"₦"+monthTotals.deds.toLocaleString(),bg:"#FEF2F2"},{l:"Total Net Pay",v:"₦"+monthTotals.net.toLocaleString(),bg:"#EFF6FF"}].map(function(s,i){
              return <div key={i} style={{...S.statCard(s.bg),padding:"8px 14px",minWidth:130}}><div style={{fontSize:14,fontWeight:800}}>{s.v}</div><div style={{fontSize:10,color:C.textMuted}}>{s.l}</div></div>;
            })}
          </div>
        </div>
      </div>

      <div style={{...S.card,overflowX:"auto"}}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{...S.th,minWidth:130}}>Staff Name</th>
              <th style={{...S.th,minWidth:80}}>Role</th>
              <th style={{...S.thC,minWidth:90}}>Basic (₦)</th>
              <th style={{...S.thC,minWidth:90}}>Allowances (₦)</th>
              <th style={{...S.thC,minWidth:90,background:"#059669"}}>Gross (₦)</th>
              <th style={{...S.thC,minWidth:90}}>Deductions (₦)</th>
              <th style={{...S.thC,minWidth:90,background:"#230E6A"}}>Net Pay (₦)</th>
              <th style={{...S.thC,minWidth:80}}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {staff.map(function(s){
              var d = getPayData(s.id);
              var c = calcNet(d);
              var allws = (parseFloat(d.housingAllowance)||0)+(parseFloat(d.transportAllowance)||0)+(parseFloat(d.mealAllowance)||0)+(parseFloat(d.leaveAllowance)||0);
              return(
                <tr key={s.id}>
                  <td style={{...S.td,fontWeight:600}}>{s.surname} {s.firstname}</td>
                  <td style={S.td}>{s.role||"Teacher"}</td>
                  <td style={S.tdC}>
                    <input type="number" style={{...S.input,width:80,padding:"2px 4px",textAlign:"right",fontSize:11}} value={d.basicSalary} onChange={function(e){updatePayData(s.id,"basicSalary",e.target.value);}} placeholder="0"/>
                  </td>
                  <td style={{...S.tdC,color:"#059669",fontWeight:600}}>{allws?allws.toLocaleString():"—"}</td>
                  <td style={{...S.tdC,fontWeight:700,color:"#059669"}}>{c.gross?c.gross.toLocaleString():"—"}</td>
                  <td style={{...S.tdC,color:C.danger}}>{c.deds?c.deds.toLocaleString():"—"}</td>
                  <td style={{...S.tdC,fontWeight:700,color:C.primaryDark,fontSize:12}}>{c.net?c.net.toLocaleString():"—"}</td>
                  <td style={S.tdC}>
                    <div style={{display:"flex",gap:4,justifyContent:"center"}}>
                      <button onClick={function(){setShowSlip(s);}} style={{...S.btn("blue"),fontSize:9,padding:"2px 7px"}}>Edit</button>
                      <button onClick={function(){printPayslip(s);}} style={{...S.btn("secondary"),fontSize:9,padding:"2px 7px"}}>Slip</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showSlip ? (
        <Modal open={!!showSlip} onClose={function(){setShowSlip(null);}} title={"Pay Details — "+showSlip.surname+" "+showSlip.firstname} wide>
          <div style={S.grid2}>
            <div style={{gridColumn:"1/-1",fontSize:12,fontWeight:700,color:C.success,borderBottom:"1px solid "+C.border,paddingBottom:8,marginBottom:8}}>EARNINGS</div>
            {[["Basic Salary","basicSalary"],["Housing Allowance","housingAllowance"],["Transport Allowance","transportAllowance"],["Meal Allowance","mealAllowance"],["Leave Allowance","leaveAllowance"]].map(function(pair){
              return <div key={pair[1]} style={S.formGroup}><label style={S.label}>{pair[0]} (₦)</label><input type="number" style={S.input} value={getPayData(showSlip.id)[pair[1]]} onChange={function(e){updatePayData(showSlip.id,pair[1],e.target.value);}} placeholder="0"/></div>;
            })}
            <div style={{gridColumn:"1/-1",fontSize:12,fontWeight:700,color:C.danger,borderBottom:"1px solid "+C.border,paddingBottom:8,marginBottom:8,marginTop:8}}>DEDUCTIONS</div>
            {[["Tax (PAYE)","taxPAYE"],["Pension (8%)","pension"],["Cooperative Levy","cooperative"],["Late Deduction","lateDeduction"],["Loan Repayment","loanRepayment"]].map(function(pair){
              return <div key={pair[1]} style={S.formGroup}><label style={S.label}>{pair[0]} (₦)</label><input type="number" style={S.input} value={getPayData(showSlip.id)[pair[1]]} onChange={function(e){updatePayData(showSlip.id,pair[1],e.target.value);}} placeholder="0"/></div>;
            })}
          </div>
          <div style={{...S.card,background:"#F0FDF4",marginTop:12}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13}}>
              <span>Gross:</span><b style={{color:"#059669"}}>₦{calcNet(getPayData(showSlip.id)).gross.toLocaleString()}</b>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13}}>
              <span>Deductions:</span><b style={{color:C.danger}}>₦{calcNet(getPayData(showSlip.id)).deds.toLocaleString()}</b>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:800,marginTop:6,borderTop:"1px solid "+C.border,paddingTop:6}}>
              <span>Net Pay:</span><b style={{color:"#230E6A"}}>₦{calcNet(getPayData(showSlip.id)).net.toLocaleString()}</b>
            </div>
          </div>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
            <button style={S.btn("secondary")} onClick={function(){setShowSlip(null);}}>Done</button>
            <button style={S.btn()} onClick={function(){printPayslip(showSlip);}}>🖨 Print Payslip</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// ITEM 15: ACADEMIC PERIOD PLANNER
// Weekly topic coverage plan per class per subject
// ══════════════════════════════════════════════════════
function CalendarModule({students, staff, settings, timetable, lessons}){
  var _selClass = useState("JSS1"); var selClass = _selClass[0]; var setSelClass = _selClass[1];
  var _selSub = useState(""); var selSub = _selSub[0]; var setSelSub = _selSub[1];
  var _selTerm = useState(CURRENT_TERM); var selTerm = _selTerm[0]; var setSelTerm = _selTerm[1];
  var _selSess = useState(CURRENT_SESSION); var selSess = _selSess[0]; var setSelSess = _selSess[1];
  var _plans = useState({}); var plans = _plans[0]; var setPlans = _plans[1];

  var subjects = getSubjects(selClass);
  var currentSub = selSub || subjects[0] || "";

  // School terms typically 13 weeks
  var WEEKS = Array.from({length:13},function(_,i){return "Week "+(i+1);});

  function getPlan(week){
    var key = selSess+"_"+selTerm+"_"+selClass+"_"+currentSub+"_"+week;
    return plans[key] || {topic:"",coverage:"",notes:""};
  }

  function updatePlan(week, field, value){
    var key = selSess+"_"+selTerm+"_"+selClass+"_"+currentSub+"_"+week;
    setPlans(function(p){
      var current = p[key] || getPlan(week);
      return {...p,[key]:{...current,[field]:value}};
    });
  }

  // Cross-reference with lesson notes
  function getLessonForWeek(week){
    return lessons.filter(function(l){
      return l.class===selClass && l.subject===currentSub && l.term===selTerm && l.session===selSess;
    }).find(function(l,i){return "Week "+(i+1)===week;});
  }

  function printPlan(){
    var hdr = buildDocHeader(settings, "ACADEMIC PERIOD PLAN — "+currentSub+" — "+selClass+" — "+selTerm+" "+selSess);
    var rows = WEEKS.map(function(week){
      var p = getPlan(week);
      return '<tr><td style="font-weight:700;width:60px;">'+week+'</td><td>'+(p.topic||'—')+'</td><td>'+(p.coverage||'—')+'</td><td>'+(p.notes||'—')+'</td></tr>';
    }).join("");
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Period Plan</title><style>'+hdr.printStyles+'</style></head><body>'+hdr.headerHtml+
      '<table><thead><tr><th>Week</th><th>Topic / Sub-topic</th><th>Coverage %</th><th>Notes</th></tr></thead><tbody>'+rows+'</tbody></table>'+hdr.footerHtml+'</body></html>';
    var w = window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.print();}
  }

  return(
    <div>
      <div style={{...S.card,marginBottom:14}}>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end",justifyContent:"space-between"}}>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            <div style={S.formGroup}><label style={S.label}>Session</label><select style={S.select} value={selSess} onChange={function(e){setSelSess(e.target.value);}}>{SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Term</label><select style={S.select} value={selTerm} onChange={function(e){setSelTerm(e.target.value);}}>{TERMS.map(function(t){return <option key={t}>{t}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Class</label><select style={S.select} value={selClass} onChange={function(e){setSelClass(e.target.value);setSelSub("");}}>{CLASSES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Subject</label><select style={S.select} value={currentSub} onChange={function(e){setSelSub(e.target.value);}}>{subjects.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
          </div>
          <button onClick={printPlan} style={S.btn()}>🖨 Print Plan</button>
        </div>
      </div>

      <div style={S.card}>
        <div style={{...S.cardTitle,marginBottom:12}}>{currentSub} — {selClass} — {selTerm} {selSess}</div>
        <div style={{overflowX:"auto"}}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={{...S.th,minWidth:70}}>Week</th>
                <th style={{...S.th,minWidth:200}}>Topic / Sub-topic</th>
                <th style={{...S.th,minWidth:100}}>Coverage %</th>
                <th style={{...S.th,minWidth:150}}>Notes / Resources</th>
                <th style={{...S.th,minWidth:80}}>Lesson Note</th>
              </tr>
            </thead>
            <tbody>
              {WEEKS.map(function(week){
                var p = getPlan(week);
                var lesson = getLessonForWeek(week);
                return(
                  <tr key={week} style={{background:p.topic?"#fff":"#FAFAFA"}}>
                    <td style={{...S.td,fontWeight:700,color:C.primaryDark}}>{week}</td>
                    <td style={S.td}>
                      <input style={{...S.input,width:"100%",padding:"3px 6px",fontSize:11}} value={p.topic} onChange={function(e){updatePlan(week,"topic",e.target.value);}} placeholder="Enter topic for this week"/>
                    </td>
                    <td style={S.tdC}>
                      <select style={{...S.select,width:90,fontSize:11}} value={p.coverage} onChange={function(e){updatePlan(week,"coverage",e.target.value);}}>
                        <option value="">—</option>
                        {["0%","25%","50%","75%","100%"].map(function(v){return <option key={v}>{v}</option>;})}
                      </select>
                    </td>
                    <td style={S.td}>
                      <input style={{...S.input,width:"100%",padding:"3px 6px",fontSize:11}} value={p.notes} onChange={function(e){updatePlan(week,"notes",e.target.value);}} placeholder="Notes..."/>
                    </td>
                    <td style={S.tdC}>
                      {lesson ? <span style={S.badge("green")}>✓ Done</span> : <span style={S.badge("yellow")}>Pending</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{fontSize:11,color:C.textMuted,marginTop:8}}>Changes save automatically as you type. Use the Print button to export a formal plan.</div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// ITEM 16: ALUMNI RECORDS
// Graduated/exited students, university placements, WAEC results
// ══════════════════════════════════════════════════════
function AlumniModule({students, setStudents, results, settings}){
  var _search = useState(""); var search = _search[0]; var setSearch = _search[1];
  var _selYear = useState(""); var selYear = _selYear[0]; var setSelYear = _selYear[1];
  var _showEdit = useState(null); var showEdit = _showEdit[0]; var setShowEdit = _showEdit[1];
  var _editData = useState({}); var editData = _editData[0]; var setEditData = _editData[1];

  var alumni = students.filter(function(s){return !s.active;});

  var exitYears = [...new Set(alumni.map(function(s){return s.exitYear||s.entrySession.split("/")[0];}).filter(Boolean))].sort().reverse();

  var filtered = alumni.filter(function(s){
    var matchSearch = !search||(s.surname+" "+s.firstname+" "+s.admissionNo).toLowerCase().includes(search.toLowerCase());
    var matchYear = !selYear||(s.exitYear||"")===selYear||(s.entrySession||"").startsWith(selYear);
    return matchSearch && matchYear;
  });

  function openEdit(s){
    setEditData({exitYear:s.exitYear||"",exitClass:s.exitClass||s.class,exitReason:s.exitReason||"Graduated",waecResult:s.waecResult||"",university:s.university||"",course:s.course||"",phone:s.phone||s.parentPhone||"",notes:s.alumniNotes||""});
    setShowEdit(s);
  }

  function saveEdit(){
    setStudents(function(p){return p.map(function(s){return s.id===showEdit.id?{...s,...editData}:s;});});
    setShowEdit(null);
  }

  function printAlumniList(){
    var hdr = buildDocHeader(settings, "ALUMNI RECORDS");
    var rows = filtered.map(function(s){
      return '<tr><td>'+s.admissionNo+'</td><td style="font-weight:600;">'+s.surname+' '+s.firstname+'</td><td>'+(s.exitClass||s.class)+'</td><td>'+(s.exitYear||"—")+'</td><td>'+(s.exitReason||"Graduated")+'</td><td>'+(s.waecResult||"—")+'</td><td>'+(s.university||"—")+'</td></tr>';
    }).join("");
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Alumni</title><style>'+hdr.printStyles+'</style></head><body>'+hdr.headerHtml+
      '<table><thead><tr><th>Adm No.</th><th>Name</th><th>Final Class</th><th>Exit Year</th><th>Reason</th><th>WAEC Result</th><th>University</th></tr></thead><tbody>'+rows+'</tbody></table>'+hdr.footerHtml+'</body></html>';
    var w = window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.print();}
  }

  var EXIT_REASONS = ["Graduated","Transferred","Withdrawn by Parent","Expelled","Completed Primary","Others"];

  return(
    <div>
      {/* Header */}
      <div style={{background:"linear-gradient(120deg,#7C3AED,#5B21B6)",borderRadius:12,padding:"18px 24px",marginBottom:16,color:"#fff",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:18,fontWeight:900}}>🎓 Alumni Records</div>
          <div style={{fontSize:12,opacity:0.8,marginTop:2}}>{alumni.length} former student{alumni.length!==1?"s":""} on record</div>
        </div>
        <button onClick={printAlumniList} style={{...S.btn(),background:"rgba(255,255,255,0.9)",color:"#7C3AED",fontWeight:700}}>🖨 Print List</button>
      </div>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:12,marginBottom:16}}>
        {[{l:"Total Alumni",v:alumni.length,bg:"#F5F3FF"},{l:"Graduated",v:alumni.filter(function(s){return s.exitReason==="Graduated";}).length,bg:"#F0FDF4"},{l:"Transferred",v:alumni.filter(function(s){return s.exitReason==="Transferred";}).length,bg:"#EFF6FF"},{l:"With WAEC",v:alumni.filter(function(s){return s.waecResult;}).length,bg:"#FFFBEB"},{l:"In University",v:alumni.filter(function(s){return s.university;}).length,bg:"#F5F3FF"}].map(function(s,i){
          return <div key={i} style={S.statCard(s.bg)}><div style={{...S.statNum,fontSize:18}}>{s.v}</div><div style={S.statLabel}>{s.l}</div></div>;
        })}
      </div>

      {/* Search */}
      <div style={{...S.card,marginBottom:14}}>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <input style={{...S.input,flex:1,minWidth:180}} placeholder="Search name or admission number..." value={search} onChange={function(e){setSearch(e.target.value);}}/>
          <select style={S.select} value={selYear} onChange={function(e){setSelYear(e.target.value);}}>
            <option value="">All Exit Years</option>
            {exitYears.map(function(y){return <option key={y}>{y}</option>;})}
          </select>
          {(search||selYear)?<button style={{...S.btn("secondary"),fontSize:11}} onClick={function(){setSearch("");setSelYear("");}}>Clear</button>:null}
        </div>
        <div style={{fontSize:11,color:C.textMuted,marginTop:6}}>{filtered.length} record{filtered.length!==1?"s":""} found</div>
      </div>

      {filtered.length===0 ? (
        <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
          <div style={{fontSize:36,marginBottom:8}}>🎓</div>
          <div style={{fontSize:13,fontWeight:600}}>{alumni.length===0?"No alumni yet — graduated students appear here automatically":"No records match your search"}</div>
          <div style={{fontSize:12,marginTop:6,color:C.textMuted}}>When you mark a student as graduated or withdrawn in the Students module, they move here automatically.</div>
        </div>
      ) : (
        <div style={S.card}>
          <table style={S.table}>
            <thead>
              <tr>
                {["Adm No.","Name","Final Class","Exit Year","Reason","WAEC Result","University / Next Step",""].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}
              </tr>
            </thead>
            <tbody>
              {filtered.map(function(s){
                return(
                  <tr key={s.id}>
                    <td style={{...S.td,fontFamily:"monospace",fontSize:10}}>{s.admissionNo}</td>
                    <td style={{...S.td,fontWeight:600}}>{s.surname} {s.firstname}</td>
                    <td style={S.tdC}>{s.exitClass||s.class}</td>
                    <td style={S.tdC}>{s.exitYear||"—"}</td>
                    <td style={S.td}><span style={S.badge(s.exitReason==="Graduated"?"green":s.exitReason==="Expelled"?"red":"yellow")}>{s.exitReason||"Graduated"}</span></td>
                    <td style={{...S.td,fontSize:11}}>{s.waecResult||<span style={{color:C.textMuted}}>Not entered</span>}</td>
                    <td style={{...S.td,fontSize:11}}>{s.university||<span style={{color:C.textMuted}}>—</span>}</td>
                    <td style={S.td}><button onClick={function(){openEdit(s);}} style={{...S.btn("blue"),fontSize:10,padding:"2px 8px"}}>Update</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showEdit ? (
        <Modal open={!!showEdit} onClose={function(){setShowEdit(null);}} title={"Update Alumni — "+showEdit.surname+" "+showEdit.firstname} wide>
          <div style={S.grid2}>
            <div style={S.formGroup}><label style={S.label}>Exit Year</label><input style={S.input} value={editData.exitYear} onChange={function(e){setEditData(function(p){return{...p,exitYear:e.target.value};});}} placeholder="e.g. 2024"/></div>
            <div style={S.formGroup}><label style={S.label}>Final Class</label><select style={{...S.select,width:"100%"}} value={editData.exitClass} onChange={function(e){setEditData(function(p){return{...p,exitClass:e.target.value};});}}>{CLASSES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Exit Reason</label><select style={{...S.select,width:"100%"}} value={editData.exitReason} onChange={function(e){setEditData(function(p){return{...p,exitReason:e.target.value};});}}>{EXIT_REASONS.map(function(r){return <option key={r}>{r}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Contact Phone</label><input style={S.input} value={editData.phone} onChange={function(e){setEditData(function(p){return{...p,phone:e.target.value};});}} placeholder="Personal phone number"/></div>
            <div style={{...S.formGroup,gridColumn:"1/-1"}}><label style={S.label}>WAEC/NECO Result Summary</label><input style={S.input} value={editData.waecResult} onChange={function(e){setEditData(function(p){return{...p,waecResult:e.target.value};});}} placeholder="e.g. 7 credits including Maths and English — 2024"/></div>
            <div style={S.formGroup}><label style={S.label}>University / Institution</label><input style={S.input} value={editData.university} onChange={function(e){setEditData(function(p){return{...p,university:e.target.value};});}} placeholder="e.g. University of Ibadan"/></div>
            <div style={S.formGroup}><label style={S.label}>Course of Study</label><input style={S.input} value={editData.course} onChange={function(e){setEditData(function(p){return{...p,course:e.target.value};});}} placeholder="e.g. Medicine and Surgery"/></div>
            <div style={{...S.formGroup,gridColumn:"1/-1"}}><label style={S.label}>Additional Notes</label><textarea style={{...S.textarea,minHeight:60}} value={editData.notes} onChange={function(e){setEditData(function(p){return{...p,notes:e.target.value};});}} placeholder="Any other notes about this alumni..."/></div>
          </div>
          <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:12}}>
            <button style={S.btn("secondary")} onClick={function(){setShowEdit(null);}}>Cancel</button>
            <button style={S.btn()} onClick={saveEdit}>Save Changes</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}


// ══════════════════════════════════════════════════════
// SCHOOL COUNSELLOR MODULE
// Class→Student flow, full profile, academic+welfare status
// Session recording with case auto-suggestions
// Daily/Weekly/Termly/Sessional reports with Mean/Median/Mode
// ══════════════════════════════════════════════════════

// ── Statistical helpers ─────────────────────────────
function calcMean(arr){ return arr.length ? (arr.reduce(function(a,b){return a+b;},0)/arr.length) : 0; }
function calcMedian(arr){
  if(!arr.length) return 0;
  var s = [...arr].sort(function(a,b){return a-b;});
  var mid = Math.floor(s.length/2);
  return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2;
}
function calcMode(arr){
  if(!arr.length) return [];
  var freq = {};
  arr.forEach(function(v){ freq[v]=(freq[v]||0)+1; });
  var max = Math.max.apply(null, Object.values(freq));
  return Object.keys(freq).filter(function(k){ return freq[k]===max; });
}
function calcFreq(arr){
  var freq = {};
  arr.forEach(function(v){ if(v) freq[v]=(freq[v]||0)+1; });
  return Object.entries(freq).sort(function(a,b){return b[1]-a[1];});
}

function getWeekNumber(dateStr){
  var d = new Date(dateStr);
  var start = new Date(d.getFullYear(),0,1);
  return Math.ceil(((d-start)/86400000+start.getDay()+1)/7);
}

function CounsellorModule({students, staff, results, conduct, clinic, attendance, settings, currentUser, counsellingSessions, setCounsellingSessions}){
  var _tab = useState("session"); var tab = _tab[0]; var setTab = _tab[1];
  var sessions = counsellingSessions;
  var setSessions = setCounsellingSessions;
  var rc = getResultConfig(settings);

  // ── Patient selection ─────────────────────────────
  var _selClass = useState("JSS1"); var selClass = _selClass[0]; var setSelClass = _selClass[1];
  var _selStudentId = useState(""); var selStudentId = _selStudentId[0]; var setSelStudentId = _selStudentId[1];

  // ── Form state ────────────────────────────────────
  var _visitTime = useState(new Date().toLocaleTimeString("en-NG",{hour:"2-digit",minute:"2-digit"}));
  var visitTime = _visitTime[0]; var setVisitTime = _visitTime[1];
  var _saved = useState(false); var saved = _saved[0]; var setSaved = _saved[1];

  var emptyForm = {
    sessionType:"Individual", referredBy:"Self",
    presentingCases:[], otherCase:"",
    academicConcerns:[], welfareConcerns:[],
    sessionNotes:"", treatmentPlan:"", followUpPlan:"",
    counsellorName:currentUser.name||"",
    followUpDate:"", outcome:"In Progress"
  };
  var _form = useState(emptyForm); var form = _form[0]; var setForm = _form[1];

  // ── Report filters ────────────────────────────────
  var _repPeriod = useState("term"); var repPeriod = _repPeriod[0]; var setRepPeriod = _repPeriod[1];
  var _repSess = useState(CURRENT_SESSION); var repSess = _repSess[0]; var setRepSess = _repSess[1];
  var _repTerm = useState(CURRENT_TERM); var repTerm = _repTerm[0]; var setRepTerm = _repTerm[1];
  var _repWeek = useState(""); var repWeek = _repWeek[0]; var setRepWeek = _repWeek[1];

  // ── Class students ────────────────────────────────
  var classStudents = students.filter(function(s){
    return s.active && s.class===selClass;
  }).sort(function(a,b){return (a.surname+a.firstname).localeCompare(b.surname+b.firstname);});

  var foundStudent = selStudentId ? students.find(function(s){return s.id===selStudentId;}) : null;

  // ── Auto-populated concern suggestions ───────────────
  var COUNSELLING_CASES = [
    "Academic underperformance","Examination anxiety","Truancy / School avoidance","Peer conflict / Bullying",
    "Family issues / Domestic problems","Grief / Bereavement","Depression / Low mood","Anxiety / Worry",
    "Anger management","Substance use concerns","Identity / Self-esteem issues","Sexual harassment",
    "Relationship problems","Career confusion","Financial stress","Health-related stress","Trauma",
    "Behavioural challenges","Social withdrawal","Religious/Spiritual concerns","Suicidal ideation","Others"
  ];

  var ACADEMIC_CONCERNS = [
    "Failing multiple subjects","Below class average","Inconsistent performance","Not submitting assignments",
    "Attention difficulties","Reading difficulties","Mathematics weakness","Language barrier","Test anxiety"
  ];

  var WELFARE_CONCERNS = [
    "Poor hygiene / Appearance","Not eating well","Signs of abuse","Parental neglect",
    "Homesickness (boarder)","Illness-related stress","Peer isolation","Emotional dysregulation",
    "Sleep difficulties","Financial hardship"
  ];

  var TREATMENT_APPROACHES = [
    "Active listening and empathy","Cognitive Behavioural Techniques (CBT)","Motivational interviewing",
    "Goal setting and action planning","Journaling / Reflective exercises","Referral to medical officer",
    "Referral to external specialist","Parent engagement session","Teacher-student mediation",
    "Study skills coaching","Stress management techniques","Relaxation exercises","Group therapy session",
    "Follow-up monitoring","Career guidance session"
  ];

  var OUTCOMES = ["In Progress","Improved","Resolved","Referred Externally","Lost to Follow-up","Escalated"];
  var REFERRED_BY = ["Self","Class Teacher","Form Master","Subject Teacher","Parent","Principal","Peer","Clinic"];

  // ── Auto-detect academic concerns from results ────────
  function getAcademicFlags(studentId){
    var stuResults = results.filter(function(r){
      return r.studentId===studentId && r.session===CURRENT_SESSION && r.term===CURRENT_TERM;
    });
    var flags = [];
    if(stuResults.length > 0){
      var avg = stuResults.reduce(function(a,r){return a+(r.total||0);},0)/stuResults.length;
      if(avg < rc.passMark) flags.push("Failing multiple subjects (avg: "+avg.toFixed(1)+"%)");
      if(avg >= rc.passMark && avg < rc.passMark+10) flags.push("Below average performance (avg: "+avg.toFixed(1)+"%)");
      var failing = stuResults.filter(function(r){return r.total < rc.passMark;});
      if(failing.length > 0) flags.push("Failing: "+failing.map(function(r){return r.subject;}).join(", "));
    } else {
      flags.push("No results recorded this term");
    }
    return flags;
  }

  // ── Auto-detect welfare concerns ─────────────────────
  function getWelfareFlags(studentId){
    var flags = [];
    // Attendance
    var stuAtt = attendance.filter(function(a){
      return a.studentId===studentId && a.session===CURRENT_SESSION && a.term===CURRENT_TERM;
    });
    if(stuAtt.length > 0){
      var pct = Math.round(stuAtt.filter(function(a){return a.present;}).length/stuAtt.length*100);
      if(pct < 75) flags.push("Poor attendance: "+pct+"% this term");
    }
    // Disciplinary
    var stuConduct = conduct.filter(function(c){
      return c.studentId===studentId && c.session===CURRENT_SESSION && c.term===CURRENT_TERM;
    });
    if(stuConduct.length > 0){
      flags.push(stuConduct.length+" disciplinary incident(s): "+stuConduct.map(function(c){return c.incidentType;}).join(", "));
    }
    // Clinic visits
    var stuClinic = clinic.filter(function(c){
      return c.studentId===studentId && c.session===CURRENT_SESSION && c.term===CURRENT_TERM;
    });
    if(stuClinic.length >= 3){
      flags.push("Frequent clinic visits: "+stuClinic.length+" this term");
    }
    return flags;
  }

  function toggleCase(arr, setter, val){
    setter(function(p){ return {...p, [arr]:p[arr].indexOf(val)>=0 ? p[arr].filter(function(x){return x!==val;}) : [...p[arr],val]}; });
  }

  function saveSession(){
    if(!foundStudent) return alert("Please select a student.");
    if(!form.presentingCases.length && !form.otherCase.trim()) return alert("Please select at least one presenting case.");
    if(!form.sessionNotes.trim()) return alert("Please enter session notes.");

    var rec = {
      id:genId(),
      studentId:foundStudent.id,
      studentName:foundStudent.surname+" "+foundStudent.firstname,
      class:foundStudent.class+(foundStudent.arm||""),
      date:today(), time:visitTime,
      session:CURRENT_SESSION, term:CURRENT_TERM,
      weekNumber:getWeekNumber(today()),
      ...form,
      presentingCasesAll:[...form.presentingCases,...(form.otherCase?[form.otherCase]:[])],
    };
    setSessions(function(p){return[rec,...p];});

    // SMS parent for serious cases
    var serious = ["Suicidal ideation","Sexual harassment","Substance use concerns","Trauma"];
    var hasSeriousCase = form.presentingCases.some(function(c){return serious.indexOf(c)>=0;});
    if(hasSeriousCase && foundStudent.parentPhone){
      sendSMS(foundStudent.parentPhone,
        "Dear Parent of "+foundStudent.firstname+" "+foundStudent.surname+", this is to inform you that your ward had a counselling session today ("+today()+"). Please contact the school counsellor urgently. — "+SCHOOL_NAME,
        "Counsellor Alert"
      );
    }

    setSaved(true);
    setTimeout(function(){setSaved(false);setSelStudentId("");setForm(emptyForm);setVisitTime(new Date().toLocaleTimeString("en-NG",{hour:"2-digit",minute:"2-digit"}));},3000);
  }

  // ── Report computation ────────────────────────────
  function getReportSessions(){
    var d = new Date();
    if(repPeriod==="daily") return sessions.filter(function(s){return s.date===today();});
    if(repPeriod==="weekly"){
      var wk = getWeekNumber(today());
      return sessions.filter(function(s){return s.weekNumber===wk&&s.session===repSess&&s.term===repTerm;});
    }
    if(repPeriod==="term") return sessions.filter(function(s){return s.session===repSess&&s.term===repTerm;});
    if(repPeriod==="session") return sessions.filter(function(s){return s.session===repSess;});
    return sessions;
  }

  function computeStats(recs){
    if(!recs.length) return null;
    // All cases across sessions
    var allCases = recs.reduce(function(acc,r){return acc.concat(r.presentingCasesAll||[]);},[]);
    var allOutcomes = recs.map(function(r){return r.outcome;});
    var byClass = {};
    recs.forEach(function(r){ byClass[r.class]=(byClass[r.class]||0)+1; });
    var sessionCounts = {};
    recs.forEach(function(r){ var d=r.date; sessionCounts[d]=(sessionCounts[d]||0)+1; });
    var countsByDate = Object.values(sessionCounts);

    return {
      total: recs.length,
      uniqueStudents: [...new Set(recs.map(function(r){return r.studentId;}))].length,
      caseFreq: calcFreq(allCases),
      outcomeFreq: calcFreq(allOutcomes),
      byClass: byClass,
      meanPerDay: calcMean(countsByDate).toFixed(1),
      medianPerDay: calcMedian(countsByDate).toFixed(1),
      modeCase: calcMode(allCases),
      modeOutcome: calcMode(allOutcomes),
      topCase: allCases.length ? calcFreq(allCases)[0] : null,
    };
  }

  // ── Clinic report data ────────────────────────────
  function getClinicReportSessions(){
    if(repPeriod==="daily") return clinic.filter(function(r){return r.date===today();});
    if(repPeriod==="weekly"){var wk=getWeekNumber(today());return clinic.filter(function(r){return getWeekNumber(r.date)===wk&&r.session===repSess&&r.term===repTerm;});}
    if(repPeriod==="term") return clinic.filter(function(r){return r.session===repSess&&r.term===repTerm;});
    return clinic.filter(function(r){return r.session===repSess;});
  }

  function computeClinicStats(recs){
    if(!recs.length) return null;
    var allConditions = recs.reduce(function(acc,r){return acc.concat((r.presentingCondition||"").split(",").map(function(s){return s.trim();}));},[]).filter(Boolean);
    var allDiagnoses = recs.map(function(r){return r.diagnosis;}).filter(Boolean);
    var allDrugs = recs.reduce(function(acc,r){return acc.concat((r.medications||[]).map(function(m){return m.drug;}));},[]).filter(Boolean);
    var allDispositions = recs.map(function(r){return r.disposition;}).filter(Boolean);
    var countsByDate = {};
    recs.forEach(function(r){countsByDate[r.date]=(countsByDate[r.date]||0)+1;});
    var dCounts = Object.values(countsByDate);
    return {
      total:recs.length,
      uniquePatients:[...new Set(recs.map(function(r){return r.studentId;}))].length,
      conditionFreq:calcFreq(allConditions).slice(0,10),
      diagnosisFreq:calcFreq(allDiagnoses).slice(0,10),
      drugFreq:calcFreq(allDrugs).slice(0,10),
      dispositionFreq:calcFreq(allDispositions),
      meanPerDay:calcMean(dCounts).toFixed(1),
      medianPerDay:calcMedian(dCounts).toFixed(1),
      modeCondition:calcMode(allConditions),
      sickBay:recs.filter(function(r){return r.disposition==="Admitted to sick bay";}).length,
      referred:recs.filter(function(r){return r.disposition==="Referred to hospital";}).length,
    };
  }

  function buildCounsellorReportHtml(){
    var repRecs = getReportSessions();
    var stats = computeStats(repRecs);
    var hdr = buildDocHeader(settings,"SCHOOL COUNSELLOR REPORT — "+repPeriod.toUpperCase()+" ("+repTerm+" "+repSess+")");
    if(!stats){
      alert("No counselling sessions found for this period.");
      return null;
    }
    var caseRows = stats.caseFreq.map(function(e){return '<tr><td>'+e[0]+'</td><td style="text-align:center;font-weight:700;">'+e[1]+'</td><td style="text-align:center;">'+(stats.total?Math.round(e[1]/stats.total*100)+"%" :"—")+'</td></tr>';}).join("");
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Counsellor Report</title><style>'+hdr.printStyles+'.highlight{background:#F5F3FF;font-weight:700;}.section{margin-bottom:14px;}.sec-title{background:#230E6A;color:#fff;padding:5px 10px;font-weight:700;font-size:11px;margin-bottom:6px;border-radius:3px;}</style></head><body>'+hdr.headerHtml+
      '<div class="section"><div class="sec-title">SUMMARY STATISTICS</div>'+
      '<table><tr><th>Metric</th><th>Value</th></tr>'+
      '<tr><td>Total Sessions</td><td class="highlight">'+stats.total+'</td></tr>'+
      '<tr><td>Unique Students Seen</td><td>'+stats.uniqueStudents+'</td></tr>'+
      '<tr><td>Mean Sessions Per Day</td><td>'+stats.meanPerDay+'</td></tr>'+
      '<tr><td>Median Sessions Per Day</td><td>'+stats.medianPerDay+'</td></tr>'+
      '<tr><td>Modal Presenting Case</td><td class="highlight">'+(stats.modeCase.join(", ")||"—")+'</td></tr>'+
      '<tr><td>Modal Outcome</td><td>'+(stats.modeOutcome.join(", ")||"—")+'</td></tr>'+
      '<tr><td>Most Common Case (Top)</td><td class="highlight">'+(stats.topCase?stats.topCase[0]+" ("+stats.topCase[1]+" times)":"—")+'</td></tr>'+
      '</table></div>'+
      '<div class="section"><div class="sec-title">PRESENTING CASES FREQUENCY</div>'+
      '<table><thead><tr><th>Case</th><th>Count</th><th>%</th></tr></thead><tbody>'+caseRows+'</tbody></table></div>'+
      '<div class="section"><div class="sec-title">OUTCOMES</div>'+
      '<table><thead><tr><th>Outcome</th><th>Count</th></tr></thead><tbody>'+
      stats.outcomeFreq.map(function(e){return '<tr><td>'+e[0]+'</td><td style="text-align:center;font-weight:700;">'+e[1]+'</td></tr>';}).join("")+
      '</tbody></table></div>'+
      '<div class="section"><div class="sec-title">SESSIONS BY CLASS</div>'+
      '<table><thead><tr><th>Class</th><th>Sessions</th></tr></thead><tbody>'+
      Object.entries(stats.byClass).sort(function(a,b){return b[1]-a[1];}).map(function(e){return '<tr><td>'+e[0]+'</td><td style="text-align:center;font-weight:700;">'+e[1]+'</td></tr>';}).join("")+
      '</tbody></table></div>'+
      hdr.footerHtml+'</body></html>';
    return html;
  }

  function printReport(){
    var html = buildCounsellorReportHtml();
    if(html) printHtmlDoc(html);
  }
  async function downloadCounsellorReportPDF(){
    var html = buildCounsellorReportHtml();
    if(!html) return;
    try{ await downloadHtmlDocAsPDF(html, "Counsellor_Report_"+repPeriod+"_"+repTerm+"_"+repSess); }
    catch(e){ alert("Could not generate PDF: "+e.message); }
  }
  async function shareCounsellorReport(){
    var html = buildCounsellorReportHtml();
    if(!html) return;
    try{ await shareHtmlDoc(html, "Counsellor_Report_"+repPeriod+"_"+repTerm+"_"+repSess, "Counsellor Report"); }
    catch(e){ alert("Could not share: "+e.message); }
  }

  function buildClinicReportHtml(){
    var repRecs = getClinicReportSessions();
    var stats = computeClinicStats(repRecs);
    var hdr = buildDocHeader(settings,"SCHOOL CLINIC REPORT — "+repPeriod.toUpperCase()+" ("+repTerm+" "+repSess+")");
    if(!stats){alert("No clinic records found for this period.");return null;}
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Clinic Report</title><style>'+hdr.printStyles+'.highlight{background:#FEF2F2;font-weight:700;}.section{margin-bottom:14px;}.sec-title{background:#8B0000;color:#fff;padding:5px 10px;font-weight:700;font-size:11px;margin-bottom:6px;border-radius:3px;}</style></head><body>'+hdr.headerHtml+
      '<div style="margin-bottom:14px;"><div class="sec-title">SUMMARY STATISTICS</div>'+
      '<table><tr><th>Metric</th><th>Value</th></tr>'+
      '<tr><td>Total Visits</td><td class="highlight">'+stats.total+'</td></tr>'+
      '<tr><td>Unique Patients</td><td>'+stats.uniquePatients+'</td></tr>'+
      '<tr><td>Mean Visits Per Day</td><td>'+stats.meanPerDay+'</td></tr>'+
      '<tr><td>Median Visits Per Day</td><td>'+stats.medianPerDay+'</td></tr>'+
      '<tr><td>Modal Condition</td><td class="highlight">'+(stats.modeCondition.slice(0,2).join(", ")||"—")+'</td></tr>'+
      '<tr><td>Admitted to Sick Bay</td><td>'+stats.sickBay+'</td></tr>'+
      '<tr><td>Referred to Hospital</td><td>'+stats.referred+'</td></tr>'+
      '</table></div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">'+
      '<div><div class="sec-title">TOP CONDITIONS</div><table><thead><tr><th>Condition</th><th>N</th></tr></thead><tbody>'+stats.conditionFreq.map(function(e){return '<tr><td>'+e[0]+'</td><td style="text-align:center;font-weight:700;">'+e[1]+'</td></tr>';}).join("")+'</tbody></table></div>'+
      '<div><div class="sec-title">DRUGS DISPENSED</div><table><thead><tr><th>Drug</th><th>N</th></tr></thead><tbody>'+stats.drugFreq.map(function(e){return '<tr><td style="font-size:9px;">'+e[0]+'</td><td style="text-align:center;font-weight:700;">'+e[1]+'</td></tr>';}).join("")+'</tbody></table></div>'+
      '<div><div class="sec-title">DISPOSITIONS</div><table><thead><tr><th>Disposition</th><th>N</th></tr></thead><tbody>'+stats.dispositionFreq.map(function(e){return '<tr><td style="font-size:9px;">'+e[0]+'</td><td style="text-align:center;font-weight:700;">'+e[1]+'</td></tr>';}).join("")+'</tbody></table></div>'+
      '</div>'+hdr.footerHtml+'</body></html>';
    return html;
  }

  function printClinicReport(){
    var html = buildClinicReportHtml();
    if(html) printHtmlDoc(html);
  }
  async function downloadClinicReportPDF(){
    var html = buildClinicReportHtml();
    if(!html) return;
    try{ await downloadHtmlDocAsPDF(html, "Clinic_Report_"+repPeriod+"_"+repTerm+"_"+repSess); }
    catch(e){ alert("Could not generate PDF: "+e.message); }
  }
  async function shareClinicReport(){
    var html = buildClinicReportHtml();
    if(!html) return;
    try{ await shareHtmlDoc(html, "Clinic_Report_"+repPeriod+"_"+repTerm+"_"+repSess, "Clinic Report"); }
    catch(e){ alert("Could not share: "+e.message); }
  }

  // ── Render ────────────────────────────────────────
  var repRecs = getReportSessions();
  var stats = computeStats(repRecs);
  var clinicRecs = getClinicReportSessions();
  var clinicStats = computeClinicStats(clinicRecs);

  function FreqBar({data, color}){
    if(!data||!data.length) return <div style={{color:C.textMuted,fontSize:11,padding:8}}>No data.</div>;
    var max = data[0][1];
    return(
      <div>
        {data.slice(0,10).map(function(entry,i){
          return(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 0",borderBottom:"1px solid "+C.border}}>
              <div style={{width:160,fontSize:10,fontWeight:600,flexShrink:0}}>{entry[0]}</div>
              <div style={{flex:1,height:12,background:"#F3F4F6",borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:(entry[1]/max*100)+"%",background:color||C.primary,borderRadius:4}}/></div>
              <div style={{width:24,fontSize:11,fontWeight:700,color:color||C.primary,textAlign:"right"}}>{entry[1]}</div>
            </div>
          );
        })}
      </div>
    );
  }

  return(
    <div>
      {/* Header */}
      <div style={{background:"linear-gradient(120deg,#059669,#065F46)",borderRadius:12,padding:"18px 24px",marginBottom:16,color:"#fff"}}>
        <div style={{fontSize:18,fontWeight:900}}>💚 School Counsellor</div>
        <div style={{fontSize:12,opacity:0.8,marginTop:2}}>{sessions.length} counselling sessions recorded · {[...new Set(sessions.map(function(s){return s.studentId;}))].length} unique students seen</div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border,flexWrap:"wrap"}}>
        {[["session","🗒 New Session"],["atrisk","🚨 At-Risk Dashboard"],["students","👥 Student Profiles"],["records","📋 Session Records"],["reports","📊 Reports"]].map(function(pair){
          return <button key={pair[0]} onClick={function(){setTab(pair[0]);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 14px"}}>{pair[1]}</button>;
        })}
      </div>

      {/* ── TAB: NEW SESSION ── */}
      {tab==="session" ? (
        <div>
          {saved ? (
            <div style={{...S.card,background:"#D1FAE5",border:"2px solid #059669",textAlign:"center",padding:32}}>
              <div style={{fontSize:32,marginBottom:8}}>✅</div>
              <div style={{fontSize:15,fontWeight:700,color:"#065F46"}}>Session recorded successfully!</div>
            </div>
          ) : (
            <div>
              {/* Step 1 — Select student */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #059669"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#059669",marginBottom:12}}>STEP 1 — Select Student</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 2fr 1fr 1fr",gap:10,alignItems:"end"}}>
                  <div style={S.formGroup}>
                    <label style={S.label}>Class</label>
                    <select style={{...S.select,width:"100%"}} value={selClass} onChange={function(e){setSelClass(e.target.value);setSelStudentId("");}}>
                      {CLASSES.map(function(c){return <option key={c}>{c}</option>;})}
                    </select>
                  </div>
                  <div style={S.formGroup}>
                    <label style={S.label}>Student Name *</label>
                    <select style={{...S.select,width:"100%"}} value={selStudentId} onChange={function(e){setSelStudentId(e.target.value);}}>
                      <option value="">— Select Student —</option>
                      {classStudents.map(function(s){return <option key={s.id} value={s.id}>{s.surname} {s.firstname}</option>;})}
                    </select>
                  </div>
                  <div style={S.formGroup}>
                    <label style={S.label}>Session Type</label>
                    <select style={{...S.select,width:"100%"}} value={form.sessionType} onChange={function(e){setForm(function(p){return{...p,sessionType:e.target.value};});}}>
                      {["Individual","Group","Follow-up","Emergency"].map(function(t){return <option key={t}>{t}</option>;})}
                    </select>
                  </div>
                  <div style={S.formGroup}>
                    <label style={S.label}>Referred By</label>
                    <select style={{...S.select,width:"100%"}} value={form.referredBy} onChange={function(e){setForm(function(p){return{...p,referredBy:e.target.value};});}}>
                      {REFERRED_BY.map(function(r){return <option key={r}>{r}</option>;})}
                    </select>
                  </div>
                </div>

                {/* Student profile card */}
                {foundStudent ? (
                  <div style={{marginTop:14,background:"linear-gradient(120deg,#059669,#065F46)",borderRadius:10,padding:"14px 18px",color:"#fff"}}>
                    <div style={{display:"flex",gap:14,alignItems:"flex-start",flexWrap:"wrap"}}>
                      <div style={{width:54,height:54,borderRadius:"50%",overflow:"hidden",border:"2px solid #A7F3D0",flexShrink:0,background:"rgba(255,255,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        {foundStudent.passport?<img src={foundStudent.passport} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:22}}>👤</span>}
                      </div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:15,fontWeight:900,color:"#A7F3D0"}}>{foundStudent.surname} {foundStudent.firstname}</div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:4,marginTop:8}}>
                          {[["Admission No.",foundStudent.admissionNo],["Class",foundStudent.class+(foundStudent.arm||"")],["Gender",foundStudent.gender],["D.O.B",formatDate(foundStudent.dob)],["Blood Group",foundStudent.bloodGroup||"—"],["Genotype",foundStudent.genotype||"—"],["Boarding",foundStudent.boardingType||"Day"],["Parent Phone",foundStudent.parentPhone||"—"],["Religion",foundStudent.religion||"—"]].map(function(pair){
                            return <div key={pair[0]}><div style={{fontSize:8,opacity:0.6,fontWeight:600}}>{pair[0]}</div><div style={{fontSize:10,fontWeight:700}}>{pair[1]}</div></div>;
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Auto-detected flags */}
                    <div style={{marginTop:12,display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                      <div style={{background:"rgba(255,255,255,0.1)",borderRadius:6,padding:"8px 12px"}}>
                        <div style={{fontSize:9,opacity:0.7,fontWeight:600,marginBottom:4}}>⚠️ ACADEMIC FLAGS (auto-detected)</div>
                        {getAcademicFlags(foundStudent.id).map(function(f,i){return <div key={i} style={{fontSize:9,opacity:0.85,marginBottom:2}}>• {f}</div>;})}
                      </div>
                      <div style={{background:"rgba(255,255,255,0.1)",borderRadius:6,padding:"8px 12px"}}>
                        <div style={{fontSize:9,opacity:0.7,fontWeight:600,marginBottom:4}}>❤️ WELFARE FLAGS (auto-detected)</div>
                        {getWelfareFlags(foundStudent.id).length ? getWelfareFlags(foundStudent.id).map(function(f,i){return <div key={i} style={{fontSize:9,opacity:0.85,marginBottom:2}}>• {f}</div>;}) : <div style={{fontSize:9,opacity:0.7}}>No welfare concerns detected</div>}
                      </div>
                    </div>
                    {/* Previous counselling sessions */}
                    {sessions.filter(function(s){return s.studentId===foundStudent.id;}).length>0 && (
                      <div style={{marginTop:10,background:"rgba(255,255,255,0.1)",borderRadius:6,padding:"8px 12px"}}>
                        <div style={{fontSize:9,opacity:0.7,fontWeight:600,marginBottom:4}}>PREVIOUS SESSIONS ({sessions.filter(function(s){return s.studentId===foundStudent.id;}).length})</div>
                        {sessions.filter(function(s){return s.studentId===foundStudent.id;}).slice(0,2).map(function(s,i){return <div key={i} style={{fontSize:9,opacity:0.85}}>{s.date} — {(s.presentingCasesAll||[]).slice(0,2).join(", ")} → {s.outcome}</div>;})}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{marginTop:10,background:"#F0FDF4",borderRadius:8,padding:14,textAlign:"center",color:C.textMuted,fontSize:12}}>Select a class and student name to see their profile and auto-detected concerns</div>
                )}
              </div>

              {/* Step 2 — Presenting cases */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #D97706"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#D97706",marginBottom:8}}>STEP 2 — Presenting Cases * <span style={{fontSize:10,fontWeight:400,color:C.textMuted}}>(select one or more)</span></div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
                  {COUNSELLING_CASES.map(function(c){
                    var sel = form.presentingCases.indexOf(c)>=0;
                    return <button key={c} type="button" onClick={function(){toggleCase("presentingCases",setForm,c);}} style={{padding:"4px 10px",borderRadius:16,fontSize:10,fontWeight:600,cursor:"pointer",border:"1px solid",background:sel?"#059669":"#fff",color:sel?"#fff":"#374151",borderColor:sel?"#059669":"#D1D5DB"}}>{sel?"✓ ":""}{c}</button>;
                  })}
                </div>
                {form.presentingCases.indexOf("Others")>=0 && (
                  <input style={S.input} value={form.otherCase} onChange={function(e){setForm(function(p){return{...p,otherCase:e.target.value};});}} placeholder="Specify other case..."/>
                )}

                {/* Academic and welfare sub-concerns */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:12}}>
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:C.primary,marginBottom:6}}>📚 Academic Concerns (optional)</div>
                    {ACADEMIC_CONCERNS.map(function(c){
                      var sel = (form.academicConcerns||[]).indexOf(c)>=0;
                      return <button key={c} type="button" onClick={function(){toggleCase("academicConcerns",setForm,c);}} style={{display:"block",width:"100%",textAlign:"left",padding:"3px 8px",marginBottom:3,borderRadius:6,fontSize:10,cursor:"pointer",border:"1px solid",background:sel?"#EFF6FF":"#fff",color:sel?"#1D4ED8":"#374151",borderColor:sel?"#1D4ED8":"#E5E7EB"}}>{sel?"✓ ":""}{c}</button>;
                    })}
                  </div>
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:"#DC2626",marginBottom:6}}>❤️ Welfare Concerns (optional)</div>
                    {WELFARE_CONCERNS.map(function(c){
                      var sel = (form.welfareConcerns||[]).indexOf(c)>=0;
                      return <button key={c} type="button" onClick={function(){toggleCase("welfareConcerns",setForm,c);}} style={{display:"block",width:"100%",textAlign:"left",padding:"3px 8px",marginBottom:3,borderRadius:6,fontSize:10,cursor:"pointer",border:"1px solid",background:sel?"#FEF2F2":"#fff",color:sel?"#DC2626":"#374151",borderColor:sel?"#DC2626":"#E5E7EB"}}>{sel?"✓ ":""}{c}</button>;
                    })}
                  </div>
                </div>
              </div>

              {/* Step 3 — Session notes and plan */}
              <div style={{...S.card,marginBottom:14,borderLeft:"4px solid #230E6A"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#230E6A",marginBottom:12}}>STEP 3 — Session Notes & Treatment Plan</div>
                <div style={S.formGroup}>
                  <label style={S.label}>Session Notes * (what was discussed)</label>
                  <textarea style={{...S.textarea,minHeight:80}} value={form.sessionNotes} onChange={function(e){setForm(function(p){return{...p,sessionNotes:e.target.value};});}} placeholder="Summarise what was discussed in the session. Keep factual and professional..."/>
                </div>
                <div style={{marginBottom:10}}>
                  <label style={S.label}>Load Treatment Approach Template</label>
                  <select style={{...S.select,width:"100%"}} value="" onChange={function(e){if(e.target.value)setForm(function(p){return{...p,treatmentPlan:p.treatmentPlan?(p.treatmentPlan+"\n• "+e.target.value):"• "+e.target.value};});}}>
                    <option value="">— Add an approach —</option>
                    {TREATMENT_APPROACHES.map(function(a){return <option key={a} value={a}>{a}</option>;})}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Treatment / Intervention Plan *</label>
                  <textarea style={{...S.textarea,minHeight:70}} value={form.treatmentPlan} onChange={function(e){setForm(function(p){return{...p,treatmentPlan:e.target.value};});}} placeholder="What interventions were applied or planned?"/>
                </div>
                <div style={S.formGroup}>
                  <label style={S.label}>Follow-up Plan</label>
                  <textarea style={{...S.textarea,minHeight:50}} value={form.followUpPlan} onChange={function(e){setForm(function(p){return{...p,followUpPlan:e.target.value};});}} placeholder="What is the plan for follow-up sessions?"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                  <div style={S.formGroup}>
                    <label style={S.label}>Outcome</label>
                    <select style={{...S.select,width:"100%"}} value={form.outcome} onChange={function(e){setForm(function(p){return{...p,outcome:e.target.value};});}}>
                      {OUTCOMES.map(function(o){return <option key={o}>{o}</option>;})}
                    </select>
                  </div>
                  <div style={S.formGroup}>
                    <label style={S.label}>Follow-up Date</label>
                    <input type="date" style={S.input} value={form.followUpDate} onChange={function(e){setForm(function(p){return{...p,followUpDate:e.target.value};});}}/>
                  </div>
                  <div style={S.formGroup}>
                    <label style={S.label}>Counsellor Name</label>
                    <input style={S.input} value={form.counsellorName} onChange={function(e){setForm(function(p){return{...p,counsellorName:e.target.value};});}}/>
                  </div>
                </div>
              </div>

              <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
                <button style={S.btn("secondary")} onClick={function(){setSelStudentId("");setForm(emptyForm);}}>Clear</button>
                <button style={{...S.btn("green"),padding:"10px 28px",fontSize:13}} onClick={saveSession}>💾 Save Session</button>
              </div>
            </div>
          )}
        </div>
      ) : null}


      {/* ── TAB: AT-RISK DASHBOARD ── */}
      {tab==="atrisk" ? (
        <div>
          {(function(){
            // Score every active student across 5 risk dimensions
            var riskStudents = students.filter(function(s){return s.active;}).map(function(s){
              var score = 0;
              var flags = [];

              // 1. Academic — results this term
              var stuResults = results.filter(function(r){
                return r.studentId===s.id && r.session===CURRENT_SESSION && r.term===CURRENT_TERM;
              });
              var avg = stuResults.length ? stuResults.reduce(function(a,r){return a+(r.total||0);},0)/stuResults.length : null;
              var failCount = stuResults.filter(function(r){return r.total<40;}).length;
              if(avg===null){ score+=1; flags.push({label:"No results recorded",cat:"academic",severity:1}); }
              else if(avg<40){ score+=4; flags.push({label:"Average below 40% ("+avg.toFixed(1)+"%)",cat:"academic",severity:4}); }
              else if(avg<50){ score+=2; flags.push({label:"Average below 50% ("+avg.toFixed(1)+"%)",cat:"academic",severity:2}); }
              if(failCount>=3){ score+=3; flags.push({label:"Failing "+failCount+" subjects",cat:"academic",severity:3}); }
              else if(failCount>0){ score+=1; flags.push({label:"Failing "+failCount+" subject(s)",cat:"academic",severity:1}); }

              // 2. Attendance — this term
              var stuAtt = attendance.filter(function(a){
                return a.studentId===s.id && a.session===CURRENT_SESSION && a.term===CURRENT_TERM;
              });
              var attPct = stuAtt.length ? Math.round(stuAtt.filter(function(a){return a.present;}).length/stuAtt.length*100) : null;
              if(attPct!==null && attPct<60){ score+=4; flags.push({label:"Attendance critical: "+attPct+"%",cat:"attendance",severity:4}); }
              else if(attPct!==null && attPct<75){ score+=2; flags.push({label:"Attendance poor: "+attPct+"%",cat:"attendance",severity:2}); }

              // 3. Disciplinary — this term
              var stuConduct = conduct.filter(function(c){
                return c.studentId===s.id && c.session===CURRENT_SESSION && c.term===CURRENT_TERM;
              });
              var seriousConduct = stuConduct.filter(function(c){
                return c.severity==="Serious"||c.severity==="Very Serious"||c.severity==="Expellable";
              });
              if(seriousConduct.length>0){ score+=4; flags.push({label:seriousConduct.length+" serious incident(s)",cat:"conduct",severity:4}); }
              else if(stuConduct.length>=3){ score+=3; flags.push({label:stuConduct.length+" incidents this term",cat:"conduct",severity:3}); }
              else if(stuConduct.length>0){ score+=1; flags.push({label:stuConduct.length+" incident(s)",cat:"conduct",severity:1}); }

              // 4. Clinic — frequent visits
              var stuClinic = clinic.filter(function(c){
                return c.studentId===s.id && c.session===CURRENT_SESSION && c.term===CURRENT_TERM;
              });
              var sickBayVisits = stuClinic.filter(function(c){return c.disposition==="Admitted to sick bay";}).length;
              var referrals = stuClinic.filter(function(c){return c.disposition==="Referred to hospital";}).length;
              if(referrals>0){ score+=3; flags.push({label:referrals+" hospital referral(s)",cat:"health",severity:3}); }
              if(sickBayVisits>0){ score+=2; flags.push({label:sickBayVisits+" sick bay admission(s)",cat:"health",severity:2}); }
              else if(stuClinic.length>=3){ score+=1; flags.push({label:stuClinic.length+" clinic visits",cat:"health",severity:1}); }

              // 5. Counselling — serious cases flagged
              var stuCounselling = sessions.filter(function(ss){return ss.studentId===s.id;});
              var seriousCases = stuCounselling.filter(function(ss){
                return (ss.presentingCasesAll||[]).some(function(c){
                  return ["Suicidal ideation","Sexual harassment","Substance use concerns","Trauma","Depression / Low mood"].indexOf(c)>=0;
                });
              });
              if(seriousCases.length>0){ score+=5; flags.push({label:"Serious counselling case: "+(seriousCases[0].presentingCasesAll||[])[0],cat:"mental",severity:5}); }
              else if(stuCounselling.length>0){ flags.push({label:stuCounselling.length+" counselling session(s)",cat:"mental",severity:0}); }

              return {
                student:s, score:score, flags:flags,
                avg:avg, attPct:attPct,
                conductCount:stuConduct.length,
                clinicCount:stuClinic.length,
                counsellingCount:stuCounselling.length,
                level: score>=8?"critical":score>=5?"high":score>=3?"moderate":score>=1?"low":"clear"
              };
            }).filter(function(r){return r.score>0;})
              .sort(function(a,b){return b.score-a.score;});

            var levelColors = {critical:"#7C0000",high:"#DC2626",moderate:"#D97706",low:"#059669"};
            var levelBg = {critical:"#FEE2E2",high:"#FEF2F2",moderate:"#FFF7ED",low:"#F0FDF4"};
            var levelBadge = {critical:"red",high:"red",moderate:"yellow",low:"green"};

            var critical = riskStudents.filter(function(r){return r.level==="critical";});
            var high = riskStudents.filter(function(r){return r.level==="high";});
            var moderate = riskStudents.filter(function(r){return r.level==="moderate";});
            var low = riskStudents.filter(function(r){return r.level==="low";});

            var CAT_ICON = {academic:"📚",attendance:"📋",conduct:"⚠️",health:"🏥",mental:"💚"};
            var CAT_COLOR = {academic:"#1D4ED8",attendance:"#D97706",conduct:"#DC2626",health:"#DC2626",mental:"#059669"};

            return(
              <div>
                {/* Summary strip */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:16}}>
                  {[
                    {l:"🚨 Critical",v:critical.length,bg:"#FEE2E2",color:"#7C0000"},
                    {l:"🔴 High Risk",v:high.length,bg:"#FEF2F2",color:"#DC2626"},
                    {l:"🟡 Moderate",v:moderate.length,bg:"#FFF7ED",color:"#D97706"},
                    {l:"🟢 Low Risk",v:low.length,bg:"#F0FDF4",color:"#059669"},
                    {l:"Total Flagged",v:riskStudents.length,bg:"#F5F3FB",color:"#230E6A"},
                  ].map(function(s,i){
                    return(
                      <div key={i} style={{background:s.bg,borderRadius:10,padding:"12px 10px",textAlign:"center",border:"1px solid "+s.color+"33"}}>
                        <div style={{fontSize:22,fontWeight:900,color:s.color}}>{s.v}</div>
                        <div style={{fontSize:10,color:s.color,fontWeight:700,marginTop:2}}>{s.l}</div>
                      </div>
                    );
                  })}
                </div>

                {riskStudents.length===0 ? (
                  <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:48}}>
                    <div style={{fontSize:40,marginBottom:10}}>✅</div>
                    <div style={{fontSize:15,fontWeight:700,color:C.success}}>No at-risk students detected</div>
                    <div style={{fontSize:12,marginTop:6}}>All students are within acceptable ranges for academic performance, attendance, conduct and health.</div>
                  </div>
                ) : (
                  <div>
                    {/* Risk legend */}
                    <div style={{...S.card,background:"#F9FAFB",marginBottom:14,display:"flex",gap:16,flexWrap:"wrap",alignItems:"center"}}>
                      <div style={{fontSize:11,fontWeight:700,color:C.textMuted}}>Risk Score:</div>
                      {[["🚨 Critical","8+ points — immediate intervention needed","#7C0000"],["🔴 High","5–7 points — urgent follow-up required","#DC2626"],["🟡 Moderate","3–4 points — monitor closely","#D97706"],["🟢 Low","1–2 points — keep watching","#059669"]].map(function(l,i){
                        return <div key={i} style={{fontSize:10}}><b style={{color:l[2]}}>{l[0]}</b> — {l[1]}</div>;
                      })}
                    </div>

                    {/* Student cards */}
                    {riskStudents.map(function(r){
                      var bg = levelBg[r.level];
                      var color = levelColors[r.level];
                      return(
                        <div key={r.student.id} style={{...S.card,marginBottom:12,borderLeft:"5px solid "+color,background:bg}}>
                          <div style={{display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap"}}>
                            {/* Photo + name */}
                            <div style={{display:"flex",gap:10,alignItems:"center",minWidth:200,flex:1}}>
                              <div style={{width:44,height:44,borderRadius:"50%",overflow:"hidden",flexShrink:0,border:"2px solid "+color,background:"#F3F4F6",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                {r.student.passport?<img src={r.student.passport} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:18}}>👤</span>}
                              </div>
                              <div>
                                <div style={{fontSize:13,fontWeight:800,color:color}}>{r.student.surname} {r.student.firstname}</div>
                                <div style={{fontSize:11,color:"#6B7280"}}>{r.student.class}{r.student.arm||""} · {r.student.admissionNo}</div>
                                <div style={{fontSize:10,color:"#6B7280"}}>{r.student.boardingType||"Day"} · {r.student.gender}</div>
                              </div>
                            </div>

                            {/* Quick stats */}
                            <div style={{display:"flex",gap:8,flexWrap:"wrap",flex:2}}>
                              {[
                                {label:"Academic Avg",value:r.avg!==null?r.avg.toFixed(1)+"%":"—",ok:r.avg!==null&&r.avg>=50},
                                {label:"Attendance",value:r.attPct!==null?r.attPct+"%":"—",ok:r.attPct!==null&&r.attPct>=75},
                                {label:"Incidents",value:r.conductCount,ok:r.conductCount===0},
                                {label:"Clinic Visits",value:r.clinicCount,ok:r.clinicCount<3},
                                {label:"Counselling",value:r.counsellingCount,ok:true},
                              ].map(function(stat,i){
                                return(
                                  <div key={i} style={{background:stat.ok?"rgba(255,255,255,0.6)":"rgba(220,38,38,0.08)",borderRadius:6,padding:"6px 10px",textAlign:"center",minWidth:70,border:"1px solid "+(stat.ok?"rgba(255,255,255,0.4)":"rgba(220,38,38,0.2)")}}>
                                    <div style={{fontSize:14,fontWeight:800,color:stat.ok?"#059669":"#DC2626"}}>{stat.value}</div>
                                    <div style={{fontSize:9,color:"#6B7280",fontWeight:600}}>{stat.label}</div>
                                  </div>
                                );
                              })}
                              <div style={{background:"rgba(0,0,0,0.06)",borderRadius:6,padding:"6px 10px",textAlign:"center",minWidth:70}}>
                                <div style={{fontSize:14,fontWeight:800,color:color}}>{r.score}</div>
                                <div style={{fontSize:9,color:"#6B7280",fontWeight:600}}>Risk Score</div>
                              </div>
                            </div>

                            {/* Level badge + action */}
                            <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end",flexShrink:0}}>
                              <span style={{...S.badge(levelBadge[r.level]),fontSize:11,padding:"4px 10px",textTransform:"uppercase",letterSpacing:"0.05em"}}>{r.level}</span>
                              <button onClick={function(){setSelStudentId(r.student.id);setSelClass(r.student.class);setTab("session");}} style={{...S.btn("green"),fontSize:10,padding:"4px 10px",whiteSpace:"nowrap"}}>📝 Counsel</button>
                            </div>
                          </div>

                          {/* Flags */}
                          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:10,paddingTop:10,borderTop:"1px solid rgba(0,0,0,0.08)"}}>
                            {r.flags.map(function(flag,i){
                              return(
                                <div key={i} style={{display:"flex",alignItems:"center",gap:4,background:"rgba(255,255,255,0.7)",borderRadius:12,padding:"3px 10px",border:"1px solid rgba(0,0,0,0.08)"}}>
                                  <span style={{fontSize:11}}>{CAT_ICON[flag.cat]||"•"}</span>
                                  <span style={{fontSize:10,fontWeight:600,color:flag.severity>=3?color:CAT_COLOR[flag.cat]||"#374151"}}>{flag.label}</span>
                                </div>
                              );
                            })}
                          </div>

                          {/* Parent contact */}
                          {r.student.parentPhone ? (
                            <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center"}}>
                              <span style={{fontSize:10,color:"#6B7280"}}>Parent: {r.student.parentPhone}</span>
                              <button onClick={function(){
                                sendSMS(r.student.parentPhone,
                                  "Dear Parent of "+r.student.firstname+" "+r.student.surname+", your child requires attention and support. Please contact the school counsellor at your earliest convenience. — "+SCHOOL_NAME,
                                  "At-Risk Alert"
                                );
                                alert("SMS sent to parent of "+r.student.firstname+" "+r.student.surname);
                              }} style={{...S.btn("secondary"),fontSize:9,padding:"2px 8px"}}>📱 Alert Parent</button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      ) : null}

      {/* ── TAB: STUDENT PROFILES ── */}
      {tab==="students" ? (
        <div>
          <div style={{...S.card,marginBottom:14}}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <select style={S.select} value={selClass} onChange={function(e){setSelClass(e.target.value);}}>
                {CLASSES.map(function(c){return <option key={c}>{c}</option>;})}
              </select>
              <div style={{fontSize:11,color:C.textMuted,alignSelf:"center"}}>{classStudents.length} students in {selClass}</div>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:12}}>
            {classStudents.map(function(s){
              var stuResults = results.filter(function(r){return r.studentId===s.id&&r.session===CURRENT_SESSION&&r.term===CURRENT_TERM;});
              var avg = stuResults.length ? (stuResults.reduce(function(a,r){return a+(r.total||0);},0)/stuResults.length).toFixed(1) : null;
              var stuAtt = attendance.filter(function(a){return a.studentId===s.id&&a.session===CURRENT_SESSION&&a.term===CURRENT_TERM;});
              var attPct = stuAtt.length ? Math.round(stuAtt.filter(function(a){return a.present;}).length/stuAtt.length*100) : null;
              var stuConduct = conduct.filter(function(c){return c.studentId===s.id&&c.session===CURRENT_SESSION&&c.term===CURRENT_TERM;});
              var stuClinic = clinic.filter(function(c){return c.studentId===s.id&&c.session===CURRENT_SESSION&&c.term===CURRENT_TERM;});
              var stuSessions = sessions.filter(function(ss){return ss.studentId===s.id;});
              var hasFlag = (avg&&parseFloat(avg)<50)||(attPct&&attPct<75)||stuConduct.length>0||stuClinic.length>=3;
              return(
                <div key={s.id} style={{...S.card,borderLeft:"3px solid "+(hasFlag?"#DC2626":"#059669")}}>
                  <div style={{...S.row,gap:10,marginBottom:8}}>
                    <div style={{width:40,height:40,borderRadius:"50%",overflow:"hidden",flexShrink:0,background:"#F3F4F6",display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {s.passport?<img src={s.passport} style={{width:"100%",height:"100%",objectFit:"cover"}} alt=""/>:<span>👤</span>}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,fontWeight:700,color:C.primaryDark}}>{s.surname} {s.firstname}</div>
                      <div style={{fontSize:10,color:C.textMuted}}>{s.admissionNo} · {s.boardingType||"Day"}</div>
                    </div>
                    {hasFlag?<span style={{fontSize:16}}>⚠️</span>:null}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                    <div style={{...S.statCard(avg&&parseFloat(avg)<50?"#FEF2F2":"#F0FDF4"),padding:"6px 8px"}}>
                      <div style={{fontSize:14,fontWeight:800,color:avg&&parseFloat(avg)<50?"#DC2626":"#059669"}}>{avg?avg+"%":"—"}</div>
                      <div style={{fontSize:9,color:C.textMuted}}>Academic Avg</div>
                    </div>
                    <div style={{...S.statCard(attPct&&attPct<75?"#FEF2F2":"#F0FDF4"),padding:"6px 8px"}}>
                      <div style={{fontSize:14,fontWeight:800,color:attPct&&attPct<75?"#DC2626":"#059669"}}>{attPct!==null?attPct+"%":"—"}</div>
                      <div style={{fontSize:9,color:C.textMuted}}>Attendance</div>
                    </div>
                    <div style={{...S.statCard(stuConduct.length>0?"#FEF2F2":"#F9FAFB"),padding:"6px 8px"}}>
                      <div style={{fontSize:14,fontWeight:800,color:stuConduct.length>0?"#DC2626":"#059669"}}>{stuConduct.length}</div>
                      <div style={{fontSize:9,color:C.textMuted}}>Incidents</div>
                    </div>
                    <div style={{...S.statCard(stuSessions.length>0?"#F5F3FF":"#F9FAFB"),padding:"6px 8px"}}>
                      <div style={{fontSize:14,fontWeight:800,color:"#7C3AED"}}>{stuSessions.length}</div>
                      <div style={{fontSize:9,color:C.textMuted}}>Counselling</div>
                    </div>
                  </div>
                  <button onClick={function(){setSelStudentId(s.id);setTab("session");}} style={{...S.btn("green"),fontSize:10,width:"100%"}}>📝 New Counselling Session</button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ── TAB: SESSION RECORDS ── */}
      {tab==="records" ? (
        <div>
          {sessions.length===0 ? (
            <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
              <div style={{fontSize:36,marginBottom:8}}>💚</div>
              <div style={{fontSize:13,fontWeight:600}}>No sessions recorded yet</div>
            </div>
          ) : (
            sessions.map(function(s){
              return(
                <div key={s.id} style={{...S.card,marginBottom:10,borderLeft:"3px solid #059669"}}>
                  <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                    <div style={{flex:1}}>
                      <div style={{...S.row,gap:8,marginBottom:4}}>
                        <span style={{fontSize:13,fontWeight:700,color:C.primaryDark}}>{s.studentName}</span>
                        <span style={S.badge("blue")}>{s.class}</span>
                        <span style={S.badge(s.sessionType==="Emergency"?"red":"green")}>{s.sessionType}</span>
                        <span style={S.badge(s.outcome==="Resolved"?"green":s.outcome==="In Progress"?"yellow":"red")}>{s.outcome}</span>
                      </div>
                      <div style={{fontSize:11,marginBottom:2}}><b>Cases:</b> {(s.presentingCasesAll||[]).join(", ")}</div>
                      <div style={{fontSize:11,color:C.textMuted}}>{s.sessionNotes.slice(0,100)}{s.sessionNotes.length>100?"...":""}</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontSize:12,fontWeight:700,color:"#059669"}}>{formatDate(s.date)}</div>
                      <div style={{fontSize:10,color:C.textMuted}}>{s.time} · {s.counsellorName}</div>
                      {s.followUpDate?<div style={{fontSize:10,color:"#D97706",fontWeight:600}}>Follow-up: {formatDate(s.followUpDate)}</div>:null}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : null}

      {/* ── TAB: REPORTS ── */}
      {tab==="reports" ? (
        <div>
          {/* Report filters */}
          <div style={{...S.card,marginBottom:14}}>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end",justifyContent:"space-between"}}>
              <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                <div style={S.formGroup}>
                  <label style={S.label}>Report Period</label>
                  <select style={S.select} value={repPeriod} onChange={function(e){setRepPeriod(e.target.value);}}>
                    {[["daily","Daily (Today)"],["weekly","Weekly (This Week)"],["term","Termly"],["session","Full Session"]].map(function(p){return <option key={p[0]} value={p[0]}>{p[1]}</option>;})}
                  </select>
                </div>
                {repPeriod!=="daily"&&<div style={S.formGroup}><label style={S.label}>Session</label><select style={S.select} value={repSess} onChange={function(e){setRepSess(e.target.value);}}>{SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}</select></div>}
                {(repPeriod==="term"||repPeriod==="weekly")&&<div style={S.formGroup}><label style={S.label}>Term</label><select style={S.select} value={repTerm} onChange={function(e){setRepTerm(e.target.value);}}>{TERMS.map(function(t){return <option key={t}>{t}</option>;})}</select></div>}
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={printReport} style={S.btn()}>🖨 Print Counsellor Report</button>
                <button onClick={downloadCounsellorReportPDF} style={S.btn("blue")}>⬇ PDF</button>
                <button onClick={shareCounsellorReport} style={S.btn("gold")}>📤 Share</button>
                <button onClick={printClinicReport} style={S.btn("secondary")}>🏥 Print Clinic Report</button>
                <button onClick={downloadClinicReportPDF} style={S.btn("blue")}>⬇ PDF</button>
                <button onClick={shareClinicReport} style={S.btn("gold")}>📤 Share</button>
              </div>
            </div>
          </div>

          {/* Counsellor stats */}
          <div style={{...S.card,marginBottom:14}}>
            <div style={S.cardTitle}>💚 Counsellor Statistics — {repPeriod==="daily"?"Today":repPeriod==="weekly"?"This Week":repTerm+" "+repSess}</div>
            {!stats ? <div style={{color:C.textMuted,fontSize:12,padding:12}}>No counselling sessions for this period.</div> : (
              <div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10,marginBottom:14}}>
                  {[{l:"Total Sessions",v:stats.total,bg:"#F5F3FF"},{l:"Unique Students",v:stats.uniqueStudents,bg:"#F0FDF4"},{l:"Mean/Day",v:stats.meanPerDay,bg:"#EFF6FF"},{l:"Median/Day",v:stats.medianPerDay,bg:"#EFF6FF"}].map(function(s,i){
                    return <div key={i} style={S.statCard(s.bg)}><div style={{fontSize:18,fontWeight:800}}>{s.v}</div><div style={{fontSize:10,color:C.textMuted}}>{s.l}</div></div>;
                  })}
                </div>
                <div style={{...S.card,background:"#F5F3FF",marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#7C3AED",marginBottom:4}}>Modal Presenting Case (most common)</div>
                  <div style={{fontSize:13,fontWeight:800}}>{stats.modeCase.join(", ")||"—"}</div>
                </div>
                <div style={S.cardTitle}>Presenting Cases Frequency</div>
                <FreqBar data={stats.caseFreq} color="#059669"/>
                <div style={{...S.cardTitle,marginTop:14}}>Outcomes</div>
                <FreqBar data={stats.outcomeFreq} color="#7C3AED"/>
              </div>
            )}
          </div>

          {/* Clinic stats */}
          <div style={S.card}>
            <div style={S.cardTitle}>🏥 Clinic Statistics — {repPeriod==="daily"?"Today":repPeriod==="weekly"?"This Week":repTerm+" "+repSess}</div>
            {!clinicStats ? <div style={{color:C.textMuted,fontSize:12,padding:12}}>No clinic records for this period.</div> : (
              <div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:10,marginBottom:14}}>
                  {[{l:"Total Visits",v:clinicStats.total,bg:"#FEF2F2"},{l:"Unique Patients",v:clinicStats.uniquePatients,bg:"#FFF7ED"},{l:"Mean/Day",v:clinicStats.meanPerDay,bg:"#EFF6FF"},{l:"Median/Day",v:clinicStats.medianPerDay,bg:"#EFF6FF"},{l:"Sick Bay",v:clinicStats.sickBay,bg:"#FEF2F2"},{l:"Referred",v:clinicStats.referred,bg:"#FEE2E2"}].map(function(s,i){
                    return <div key={i} style={S.statCard(s.bg)}><div style={{fontSize:18,fontWeight:800}}>{s.v}</div><div style={{fontSize:10,color:C.textMuted}}>{s.l}</div></div>;
                  })}
                </div>
                <div style={{...S.card,background:"#FEF2F2",marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#DC2626",marginBottom:4}}>Modal Condition (most common)</div>
                  <div style={{fontSize:13,fontWeight:800}}>{clinicStats.modeCondition.slice(0,2).join(", ")||"—"}</div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>
                  <div><div style={S.cardTitle}>Top Conditions</div><FreqBar data={clinicStats.conditionFreq} color="#DC2626"/></div>
                  <div><div style={S.cardTitle}>Drugs Dispensed</div><FreqBar data={clinicStats.drugFreq} color="#D97706"/></div>
                  <div><div style={S.cardTitle}>Dispositions</div><FreqBar data={clinicStats.dispositionFreq} color="#059669"/></div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}


// ══════════════════════════════════════════════════════
// ADMISSIONS PORTAL
// Public application form + Admin review & approval
// Reference number generation, SMS notifications
// ══════════════════════════════════════════════════════
function AdmissionsModule({students, setStudents, settings, currentUser, applications, setApplications}){
  var _tab = useState("applications"); var tab = _tab[0]; var setTab = _tab[1];
  var _search = useState(""); var search = _search[0]; var setSearch = _search[1];
  var _filterStatus = useState(""); var filterStatus = _filterStatus[0]; var setFilterStatus = _filterStatus[1];
  var _viewing = useState(null); var viewing = _viewing[0]; var setViewing = _viewing[1];
  var _showPortal = useState(false); var showPortal = _showPortal[0]; var setShowPortal = _showPortal[1];

  // ── Application form state (public portal) ────────────
  var emptyApp = {
    // Student details
    surname:"", firstname:"", middlename:"", dob:"", gender:"Male",
    religion:"Islam", bloodGroup:"O+", genotype:"AA", nationality:"Nigerian",
    stateOfOrigin:"Osun", lga:"",
    // Previous school
    prevSchool:"", prevClass:"", prevSession:"",
    // Parent/Guardian
    parentName:"", parentPhone:"", parentAlt:"", parentEmail:"",
    parentOccupation:"", parentAddress:"",
    // Application details
    applyingForClass:"JSS1", entrySession:CURRENT_SESSION,
    boardingType:"Day", howHeard:"",
    // Documents
    passport:"", birthCert:false, reportCard:false, testimonial:false,
    declaration:false
  };
  var _appForm = useState(emptyApp); var appForm = _appForm[0]; var setAppForm = _appForm[1];
  var _appStep = useState(1); var appStep = _appStep[0]; var setAppStep = _appStep[1];
  var _appSubmitted = useState(null); var appSubmitted = _appSubmitted[0]; var setAppSubmitted = _appSubmitted[1];
  var _submitting = useState(false); var submitting = _submitting[0]; var setSubmitting = _submitting[1];

  var STATES = ["Osun","Lagos","Oyo","Ogun","Ondo","Ekiti","Kwara","Kogi","Abuja FCT","Others"];
  var HOW_HEARD = ["Word of mouth","Social media","School fair","Mosque/Church","Former student","Billboard","Others"];

  function genRefNo(){
    return "ADM/"+CURRENT_SESSION.split("/")[0]+"/"+String(applications.length+1001).padStart(4,"0");
  }

  function submitApplication(){
    if(!appForm.surname.trim()||!appForm.firstname.trim()) return alert("Student name is required.");
    if(!appForm.dob) return alert("Date of birth is required.");
    if(!appForm.parentName.trim()||!appForm.parentPhone.trim()) return alert("Parent/Guardian details are required.");
    if(!appForm.declaration) return alert("Please confirm the declaration to submit.");

    setSubmitting(true);
    var refNo = genRefNo();
    var app = {
      ...appForm,
      id:genId(), refNo:refNo,
      status:"Pending", submittedAt:today(),
      reviewedBy:"", reviewedAt:"", remarks:"",
      admissionNo:""
    };
    setApplications(function(p){return[app,...p];});

    // SMS confirmation to parent
    if(appForm.parentPhone){
      sendSMS(appForm.parentPhone,
        "Dear "+appForm.parentName+", your application for "+appForm.firstname+" "+appForm.surname+" has been received by "+SCHOOL_NAME+". Reference No: "+refNo+". We will contact you on the outcome. Thank you.",
        "Admission Application"
      );
    }

    setSubmitting(false);
    setAppSubmitted({refNo:refNo, name:appForm.firstname+" "+appForm.surname});
    setAppForm(emptyApp);
    setAppStep(1);
  }

  function updateStatus(appId, status, remarks){
    var app = applications.find(function(a){return a.id===appId;});
    setApplications(function(p){return p.map(function(a){
      if(a.id!==appId) return a;
      return {...a, status:status, reviewedBy:currentUser.name, reviewedAt:today(), remarks:remarks||a.remarks};
    });});

    // SMS parent
    if(app&&app.parentPhone){
      var msg = status==="Approved"
        ? "Dear "+app.parentName+", we are pleased to inform you that "+app.firstname+" "+app.surname+"'s application (Ref: "+app.refNo+") has been APPROVED. Please visit the school to complete enrolment. — "+SCHOOL_NAME
        : status==="Rejected"
        ? "Dear "+app.parentName+", we regret to inform you that "+app.firstname+" "+app.surname+"'s application (Ref: "+app.refNo+") was not successful at this time. "+((remarks||"")?remarks+" ":"")+"Thank you for your interest. — "+SCHOOL_NAME
        : "Dear "+app.parentName+", the application for "+app.firstname+" (Ref: "+app.refNo+") status has been updated to: "+status+". — "+SCHOOL_NAME;
      sendSMS(app.parentPhone, msg, "Admission Update");
    }
  }

  function enrollFromApplication(app){
    if(!window.confirm("Convert this application into a full student record?")) return;
    var yr = app.entrySession.split("/")[0];
    var newStu = {
      id:genId(),
      admissionNo:admNo(yr, students.length+1),
      surname:app.surname, firstname:app.firstname, middlename:app.middlename,
      dob:app.dob, gender:app.gender, religion:app.religion,
      bloodGroup:app.bloodGroup, genotype:app.genotype,
      class:app.applyingForClass, arm:"A",
      entryClass:app.applyingForClass, entrySession:app.entrySession,
      boardingType:app.boardingType,
      parentName:app.parentName, parentPhone:app.parentPhone,
      parentEmail:app.parentEmail, address:app.parentAddress,
      passport:app.passport||"", active:true,
      phone:"", nationality:app.nationality, stateOfOrigin:app.stateOfOrigin
    };
    setStudents(function(p){return[...p,newStu];});
    updateStatus(app.id,"Enrolled","Enrolled as "+newStu.admissionNo);
    alert("Student enrolled successfully! Admission No: "+newStu.admissionNo);
  }

  var filtered = applications.filter(function(a){
    var ms = !search||(a.surname+" "+a.firstname+" "+a.refNo).toLowerCase().includes(search.toLowerCase());
    var mf = !filterStatus||a.status===filterStatus;
    return ms && mf;
  });

  var stats = {
    total:applications.length,
    pending:applications.filter(function(a){return a.status==="Pending";}).length,
    approved:applications.filter(function(a){return a.status==="Approved";}).length,
    enrolled:applications.filter(function(a){return a.status==="Enrolled";}).length,
    rejected:applications.filter(function(a){return a.status==="Rejected";}).length,
  };

  // ── Print admission letter ────────────────────────────
  function printAdmissionLetter(app){
    var hdr = buildDocHeader(settings,"ADMISSION OFFER LETTER");
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Admission Letter</title><style>'+hdr.printStyles+'body{max-width:600px;margin:0 auto;}p{margin-bottom:10px;line-height:1.7;}</style></head><body>'+hdr.headerHtml+
      '<p style="text-align:right;">'+formatDate(today())+'</p>'+
      '<p><b>'+app.parentName+'</b><br/>'+app.parentAddress+'<br/>'+app.parentPhone+'</p>'+
      '<p>Dear '+app.parentName+',</p>'+
      '<p><b>RE: OFFER OF ADMISSION — '+app.firstname.toUpperCase()+' '+app.surname.toUpperCase()+'</b></p>'+
      '<p>We are pleased to inform you that following a review of your ward\'s application (Ref: '+app.refNo+'), the management of <b>'+SCHOOL_NAME+'</b> has approved the admission of <b>'+app.firstname+' '+app.middlename+' '+app.surname+'</b> into <b>'+app.applyingForClass+'</b> for the <b>'+app.entrySession+'</b> academic session.</p>'+
      '<p>Please report to the school\'s administrative office with the following:<br/>• Original birth certificate or sworn affidavit<br/>• Last school report card and transfer certificate<br/>• Four (4) recent passport photographs<br/>• Evidence of payment of acceptance fee<br/>• Completed medical form</p>'+
      '<p>The school resumes on the date stated in the academic calendar. We look forward to welcoming your ward into the Assanusiyyah family.</p>'+
      '<p>Yours faithfully,</p>'+
      hdr.footerHtml+
      '<p style="margin-top:20px;font-size:9px;color:#999;">Reference: '+app.refNo+' | Issued: '+today()+'</p>'+
      '</body></html>';
    var w=window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.print();}
  }

  return(
    <div>
      {/* Header */}
      <div style={{background:"linear-gradient(120deg,#230E6A,#6B491B)",borderRadius:12,padding:"18px 24px",marginBottom:16,color:"#fff",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:18,fontWeight:900}}>📝 Admissions Portal</div>
          <div style={{fontSize:12,opacity:0.8,marginTop:2}}>{stats.total} applications · {stats.pending} pending · {stats.approved} approved · {stats.enrolled} enrolled</div>
        </div>
        <button onClick={function(){setShowPortal(true);setAppSubmitted(null);}} style={{...S.btn(),background:"rgba(255,255,255,0.9)",color:"#230E6A",fontWeight:700}}>+ New Application</button>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border}}>
        {[["applications","📋 All Applications"],["pending","⏳ Pending Review"]].map(function(pair){
          return <button key={pair[0]} onClick={function(){setTab(pair[0]);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 14px"}}>{pair[1]}{pair[0]==="pending"?<span style={{background:"#DC2626",color:"#fff",borderRadius:"50%",fontSize:9,padding:"0 4px",marginLeft:4}}>{stats.pending}</span>:null}</button>;
        })}
      </div>

      {/* Search + filter */}
      <div style={{...S.card,marginBottom:14}}>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <input style={{...S.input,flex:1,minWidth:180}} placeholder="Search name or reference number..." value={search} onChange={function(e){setSearch(e.target.value);}}/>
          <select style={S.select} value={filterStatus} onChange={function(e){setFilterStatus(e.target.value);}}>
            <option value="">All Statuses</option>
            {["Pending","Under Review","Approved","Rejected","Enrolled"].map(function(s){return <option key={s}>{s}</option>;})}
          </select>
          {(search||filterStatus)?<button style={{...S.btn("secondary"),fontSize:11}} onClick={function(){setSearch("");setFilterStatus("");}}>Clear</button>:null}
        </div>
      </div>

      {/* Application detail view */}
      {viewing ? (
        <div style={S.card}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
            <div style={{fontSize:14,fontWeight:700,color:C.primaryDark}}>Application — {viewing.refNo}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {viewing.status==="Approved"&&<button onClick={function(){enrollFromApplication(viewing);}} style={{...S.btn("green"),fontSize:11}}>✅ Enrol Student</button>}
              {viewing.status==="Approved"&&<button onClick={function(){printAdmissionLetter(viewing);}} style={{...S.btn("blue"),fontSize:11}}>🖨 Print Offer Letter</button>}
              {viewing.status==="Pending"||viewing.status==="Under Review" ? (
                <div style={{display:"flex",gap:6}}>
                  <button onClick={function(){updateStatus(viewing.id,"Under Review","");setViewing(function(p){return{...p,status:"Under Review"};});}} style={{...S.btn("secondary"),fontSize:11}}>Review</button>
                  <button onClick={function(){var r=window.prompt("Reason for approval (optional):");if(r!==null){updateStatus(viewing.id,"Approved",r);setViewing(function(p){return{...p,status:"Approved"};});}}} style={{...S.btn("green"),fontSize:11}}>✅ Approve</button>
                  <button onClick={function(){var r=window.prompt("Reason for rejection:");if(r){updateStatus(viewing.id,"Rejected",r);setViewing(function(p){return{...p,status:"Rejected"};});}}} style={{...S.btn("danger"),fontSize:11}}>❌ Reject</button>
                </div>
              ):null}
              <button onClick={function(){setViewing(null);}} style={{...S.btn("secondary"),fontSize:11}}>← Back</button>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            {/* Student details */}
            <div style={S.card}>
              <div style={{fontSize:11,fontWeight:700,color:C.primaryDark,marginBottom:10}}>STUDENT DETAILS</div>
              {viewing.passport&&<img src={viewing.passport} alt="" style={{width:80,height:80,objectFit:"cover",borderRadius:6,border:"2px solid "+C.border,marginBottom:8}}/>}
              {[["Full Name",viewing.surname+" "+viewing.firstname+" "+(viewing.middlename||"")],["Date of Birth",formatDate(viewing.dob)],["Gender",viewing.gender],["Religion",viewing.religion],["Blood Group",viewing.bloodGroup],["Genotype",viewing.genotype],["Nationality",viewing.nationality],["State of Origin",viewing.stateOfOrigin],["L.G.A",viewing.lga||"—"]].map(function(pair,i){
                return <div key={i} style={{display:"flex",gap:6,padding:"3px 0",borderBottom:"1px solid #F3F4F6",fontSize:12}}><span style={{color:C.textMuted,minWidth:110}}>{pair[0]}:</span><b>{pair[1]}</b></div>;
              })}
            </div>

            <div>
              {/* Parent details */}
              <div style={{...S.card,marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:700,color:C.primaryDark,marginBottom:10}}>PARENT/GUARDIAN</div>
                {[["Name",viewing.parentName],["Phone",viewing.parentPhone],["Alt Phone",viewing.parentAlt||"—"],["Email",viewing.parentEmail||"—"],["Occupation",viewing.parentOccupation||"—"],["Address",viewing.parentAddress||"—"]].map(function(pair,i){
                  return <div key={i} style={{display:"flex",gap:6,padding:"3px 0",borderBottom:"1px solid #F3F4F6",fontSize:12}}><span style={{color:C.textMuted,minWidth:90}}>{pair[0]}:</span><b>{pair[1]}</b></div>;
                })}
              </div>

              {/* Application details */}
              <div style={S.card}>
                <div style={{fontSize:11,fontWeight:700,color:C.primaryDark,marginBottom:10}}>APPLICATION DETAILS</div>
                {[["Reference No.",viewing.refNo],["Applying For",viewing.applyingForClass],["Session",viewing.entrySession],["Boarding",viewing.boardingType],["Previous School",viewing.prevSchool||"—"],["Previous Class",viewing.prevClass||"—"],["Submitted",formatDate(viewing.submittedAt)],["Status",viewing.status],["Reviewed By",viewing.reviewedBy||"—"]].map(function(pair,i){
                  return <div key={i} style={{display:"flex",gap:6,padding:"3px 0",borderBottom:"1px solid #F3F4F6",fontSize:12}}><span style={{color:C.textMuted,minWidth:110}}>{pair[0]}:</span><b>{pair[1]}</b></div>;
                })}
                {viewing.remarks&&<div style={{marginTop:8,background:"#FFF7ED",borderRadius:6,padding:"6px 10px",fontSize:11}}><b>Remarks:</b> {viewing.remarks}</div>}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Applications list */
        filtered.length===0 ? (
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
            <div style={{fontSize:36,marginBottom:8}}>📝</div>
            <div style={{fontSize:13,fontWeight:600}}>{applications.length===0?"No applications yet":"No applications match your search"}</div>
            {applications.length===0&&<div style={{fontSize:12,marginTop:6}}>Click "+ New Application" to register an applicant, or share the portal link for online applications.</div>}
          </div>
        ) : (
          filtered.filter(function(a){return tab==="pending"?a.status==="Pending":true;}).map(function(a){
            var statusColor = a.status==="Approved"||a.status==="Enrolled"?"green":a.status==="Rejected"?"red":a.status==="Under Review"?"blue":"yellow";
            return(
              <div key={a.id} style={{...S.card,marginBottom:10,cursor:"pointer",borderLeft:"3px solid "+(a.status==="Approved"||a.status==="Enrolled"?C.success:a.status==="Rejected"?C.danger:"#D97706")}} onClick={function(){setViewing(a);}}>
                <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                  <div style={{flex:1}}>
                    <div style={{...S.row,gap:8,marginBottom:4}}>
                      <span style={{fontSize:13,fontWeight:700,color:C.primaryDark}}>{a.surname} {a.firstname}</span>
                      <span style={S.badge("blue")}>{a.applyingForClass}</span>
                      <span style={S.badge(statusColor)}>{a.status}</span>
                    </div>
                    <div style={{fontSize:11,color:C.textMuted}}>Ref: <b>{a.refNo}</b> · Parent: {a.parentName} · {a.parentPhone}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:11,fontWeight:600,color:C.textMuted}}>{formatDate(a.submittedAt)}</div>
                    <div style={{fontSize:10,color:C.textMuted}}>{a.boardingType} · {a.entrySession}</div>
                  </div>
                </div>
              </div>
            );
          })
        )
      )}

      {/* ── APPLICATION PORTAL MODAL ── */}
      {showPortal ? (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,overflowY:"auto",padding:20}}>
          <div style={{maxWidth:700,margin:"0 auto",background:"#fff",borderRadius:14,overflow:"hidden"}}>
            {/* Portal header */}
            <div style={{background:"linear-gradient(120deg,#230E6A,#6B491B)",padding:"20px 24px",color:"#fff"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:16,fontWeight:900}}>{SCHOOL_NAME}</div>
                  <div style={{fontSize:13,opacity:0.8,marginTop:2}}>Admission Application Form — {CURRENT_SESSION}</div>
                </div>
                <button onClick={function(){setShowPortal(false);setAppStep(1);setAppForm(emptyApp);setAppSubmitted(null);}} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",padding:"6px 12px",borderRadius:6,cursor:"pointer",fontSize:12}}>✕ Close</button>
              </div>
              {/* Step indicator */}
              <div style={{display:"flex",gap:4,marginTop:14}}>
                {["Student Details","Parent Details","Application","Submit"].map(function(s,i){
                  return <div key={i} style={{flex:1,textAlign:"center",fontSize:10,fontWeight:appStep===i+1?700:400,color:appStep===i+1?"#F0C060":appStep>i+1?"#A7F3D0":"rgba(255,255,255,0.5)"}}>
                    <div style={{height:3,background:appStep>i?"#F0C060":appStep===i+1?"#F0C060":"rgba(255,255,255,0.2)",borderRadius:2,marginBottom:4}}/>
                    {i+1}. {s}
                  </div>;
                })}
              </div>
            </div>

            <div style={{padding:"20px 24px"}}>
              {appSubmitted ? (
                <div style={{textAlign:"center",padding:32}}>
                  <div style={{fontSize:48,marginBottom:12}}>🎉</div>
                  <div style={{fontSize:18,fontWeight:900,color:C.success,marginBottom:8}}>Application Submitted!</div>
                  <div style={{fontSize:14,color:C.textMuted,marginBottom:16}}>A confirmation SMS has been sent to the parent.</div>
                  <div style={{background:"#F0FDF4",borderRadius:10,padding:"16px 24px",marginBottom:16}}>
                    <div style={{fontSize:12,color:C.textMuted}}>Application Reference Number</div>
                    <div style={{fontSize:28,fontWeight:900,color:C.primaryDark,letterSpacing:2}}>{appSubmitted.refNo}</div>
                    <div style={{fontSize:12,color:C.textMuted,marginTop:4}}>For: {appSubmitted.name}</div>
                  </div>
                  <div style={{fontSize:12,color:C.textMuted}}>Please save this reference number. The school will contact you with the outcome of the application.</div>
                  <button onClick={function(){setShowPortal(false);setAppSubmitted(null);}} style={{...S.btn(),marginTop:20}}>Close</button>
                </div>
              ) : (
                <div>
                  {/* STEP 1 — Student Details */}
                  {appStep===1&&(
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:14}}>Student Information</div>
                      {/* Passport photo */}
                      <div style={{...S.formGroup,marginBottom:14}}>
                        <label style={S.label}>Passport Photograph</label>
                        <div style={{display:"flex",gap:12,alignItems:"center"}}>
                          <div style={{width:80,height:80,borderRadius:8,overflow:"hidden",border:"2px solid "+C.border,background:"#F3F4F6",display:"flex",alignItems:"center",justifyContent:"center"}}>
                            {appForm.passport?<img src={appForm.passport} style={{width:"100%",height:"100%",objectFit:"cover"}} alt=""/>:<span style={{fontSize:28}}>👤</span>}
                          </div>
                          <div>
                            <input type="file" accept="image/*" style={{fontSize:11}} onChange={function(e){var f=e.target.files[0];if(!f)return;if(f.size>41000)return alert("Photo must be under 40KB.");var r=new FileReader();r.onload=function(ev){setAppForm(function(p){return{...p,passport:ev.target.result};});};r.readAsDataURL(f);}}/>
                            <div style={{fontSize:9,color:C.textMuted,marginTop:4}}>Max 40KB. Clear, frontal photo.</div>
                          </div>
                        </div>
                      </div>
                      <div style={S.grid2}>
                        <div style={S.formGroup}><label style={S.label}>Surname *</label><input style={S.input} value={appForm.surname} onChange={function(e){setAppForm(function(p){return{...p,surname:e.target.value};});}} placeholder="Family name"/></div>
                        <div style={S.formGroup}><label style={S.label}>First Name *</label><input style={S.input} value={appForm.firstname} onChange={function(e){setAppForm(function(p){return{...p,firstname:e.target.value};});}} placeholder="First name"/></div>
                        <div style={S.formGroup}><label style={S.label}>Middle Name</label><input style={S.input} value={appForm.middlename} onChange={function(e){setAppForm(function(p){return{...p,middlename:e.target.value};});}}/></div>
                        <div style={{...S.formGroup,background:"#FEF3C7",borderRadius:8,padding:"6px 8px",border:"1px solid #F59E0B"}}><label style={{...S.label,color:"#92400E",fontWeight:800}}>📅 Date of Birth *</label><input type="date" style={{...S.input,borderColor:"#F59E0B"}} value={appForm.dob} onChange={function(e){setAppForm(function(p){return{...p,dob:e.target.value};});}}/></div>
                        <div style={S.formGroup}><label style={S.label}>Gender</label><select style={{...S.select,width:"100%"}} value={appForm.gender} onChange={function(e){setAppForm(function(p){return{...p,gender:e.target.value};});}}>  <option>Male</option><option>Female</option></select></div>
                        <div style={S.formGroup}><label style={S.label}>Religion</label><select style={{...S.select,width:"100%"}} value={appForm.religion} onChange={function(e){setAppForm(function(p){return{...p,religion:e.target.value};});}}>  <option>Islam</option><option>Christianity</option><option>Traditional</option></select></div>
                        <div style={S.formGroup}><label style={S.label}>Blood Group</label><select style={{...S.select,width:"100%"}} value={appForm.bloodGroup} onChange={function(e){setAppForm(function(p){return{...p,bloodGroup:e.target.value};});}}>{["O+","O-","A+","A-","B+","B-","AB+","AB-"].map(function(b){return <option key={b}>{b}</option>;})}</select></div>
                        <div style={S.formGroup}><label style={S.label}>Genotype</label><select style={{...S.select,width:"100%"}} value={appForm.genotype} onChange={function(e){setAppForm(function(p){return{...p,genotype:e.target.value};});}}>{["AA","AS","AC","SS","SC"].map(function(g){return <option key={g}>{g}</option>;})}</select></div>
                        <div style={S.formGroup}><label style={S.label}>State of Origin</label><select style={{...S.select,width:"100%"}} value={appForm.stateOfOrigin} onChange={function(e){setAppForm(function(p){return{...p,stateOfOrigin:e.target.value};});}}>{STATES.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
                        <div style={S.formGroup}><label style={S.label}>L.G.A</label><input style={S.input} value={appForm.lga} onChange={function(e){setAppForm(function(p){return{...p,lga:e.target.value};});}}/></div>
                      </div>
                      <div style={{marginTop:12}}><label style={S.label}>Previous School</label><input style={S.input} value={appForm.prevSchool} onChange={function(e){setAppForm(function(p){return{...p,prevSchool:e.target.value};});}} placeholder="Name of last school attended (if any)"/></div>
                    </div>
                  )}

                  {/* STEP 2 — Parent Details */}
                  {appStep===2&&(
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:14}}>Parent / Guardian Information</div>
                      <div style={S.grid2}>
                        <div style={S.formGroup}><label style={S.label}>Full Name *</label><input style={S.input} value={appForm.parentName} onChange={function(e){setAppForm(function(p){return{...p,parentName:e.target.value};});}} placeholder="Parent/Guardian full name"/></div>
                        <div style={S.formGroup}><label style={S.label}>Phone Number *</label><input style={S.input} type="tel" value={appForm.parentPhone} onChange={function(e){setAppForm(function(p){return{...p,parentPhone:e.target.value};});}} placeholder="08012345678"/></div>
                        <div style={S.formGroup}><label style={S.label}>Alternative Phone</label><input style={S.input} type="tel" value={appForm.parentAlt} onChange={function(e){setAppForm(function(p){return{...p,parentAlt:e.target.value};});}}/></div>
                        <div style={S.formGroup}><label style={S.label}>Email Address</label><input style={S.input} type="email" value={appForm.parentEmail} onChange={function(e){setAppForm(function(p){return{...p,parentEmail:e.target.value};});}}/></div>
                        <div style={S.formGroup}><label style={S.label}>Occupation</label><input style={S.input} value={appForm.parentOccupation} onChange={function(e){setAppForm(function(p){return{...p,parentOccupation:e.target.value};});}}/></div>
                      </div>
                      <div style={S.formGroup}><label style={S.label}>Home Address *</label><textarea style={{...S.textarea,minHeight:60}} value={appForm.parentAddress} onChange={function(e){setAppForm(function(p){return{...p,parentAddress:e.target.value};});}} placeholder="Full residential address"/></div>
                    </div>
                  )}

                  {/* STEP 3 — Application Preferences */}
                  {appStep===3&&(
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:14}}>Application Preferences</div>
                      <div style={S.grid2}>
                        <div style={S.formGroup}><label style={S.label}>Applying for Class *</label><select style={{...S.select,width:"100%"}} value={appForm.applyingForClass} onChange={function(e){setAppForm(function(p){return{...p,applyingForClass:e.target.value};});}}>{CLASSES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
                        <div style={S.formGroup}><label style={S.label}>Entry Session *</label><select style={{...S.select,width:"100%"}} value={appForm.entrySession} onChange={function(e){setAppForm(function(p){return{...p,entrySession:e.target.value};});}}>{SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
                        <div style={S.formGroup}><label style={S.label}>Boarding Type</label><select style={{...S.select,width:"100%"}} value={appForm.boardingType} onChange={function(e){setAppForm(function(p){return{...p,boardingType:e.target.value};});}}><option>Day</option><option>Boarder</option></select></div>
                        <div style={S.formGroup}><label style={S.label}>How did you hear about us?</label><select style={{...S.select,width:"100%"}} value={appForm.howHeard} onChange={function(e){setAppForm(function(p){return{...p,howHeard:e.target.value};});}}><option value="">— Select —</option>{HOW_HEARD.map(function(h){return <option key={h}>{h}</option>;})}</select></div>
                      </div>
                      <div style={{...S.card,background:"#EFF6FF",marginTop:12}}>
                        <div style={{fontSize:12,fontWeight:700,color:C.primary,marginBottom:10}}>Documents Checklist</div>
                        {[["birthCert","Original Birth Certificate or Sworn Affidavit"],["reportCard","Last School Report Card"],["testimonial","School Testimonial / Transfer Certificate"],].map(function(pair){
                          return <label key={pair[0]} style={{display:"flex",gap:8,alignItems:"center",marginBottom:8,cursor:"pointer",fontSize:12}}>
                            <input type="checkbox" checked={appForm[pair[0]]||false} onChange={function(){setAppForm(function(p){return{...p,[pair[0]]:!p[pair[0]]};});}}/>
                            {pair[1]}
                          </label>;
                        })}
                      </div>
                    </div>
                  )}

                  {/* STEP 4 — Declaration & Submit */}
                  {appStep===4&&(
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:C.primaryDark,marginBottom:14}}>Declaration & Submission</div>
                      <div style={{...S.card,background:"#F5F3FB",marginBottom:14}}>
                        <div style={{fontSize:12,lineHeight:1.7}}>
                          I, <b>{appForm.parentName||"____________________"}</b>, hereby declare that all information provided in this application is true and accurate to the best of my knowledge. I understand that the submission of false information may lead to the cancellation of this application or admission.
                        </div>
                      </div>
                      <label style={{display:"flex",gap:8,alignItems:"flex-start",cursor:"pointer",fontSize:12,marginBottom:16}}>
                        <input type="checkbox" style={{marginTop:2}} checked={appForm.declaration||false} onChange={function(){setAppForm(function(p){return{...p,declaration:!p.declaration};});}}/>
                        <span>I confirm that the above declaration is true and I agree to the school's terms and conditions.</span>
                      </label>
                      <div style={{...S.card,background:"#F0FDF4"}}>
                        <div style={{fontSize:12,fontWeight:700,color:C.success,marginBottom:8}}>Application Summary</div>
                        {[["Student",appForm.surname+" "+appForm.firstname],["Date of Birth",formatDate(appForm.dob)],["Applying For",appForm.applyingForClass+" — "+appForm.entrySession],["Boarding",appForm.boardingType],["Parent",appForm.parentName],["Parent Phone",appForm.parentPhone]].map(function(pair,i){
                          return <div key={i} style={{display:"flex",gap:8,padding:"3px 0",borderBottom:"1px solid #E5E7EB",fontSize:12}}><span style={{color:C.textMuted,minWidth:100}}>{pair[0]}:</span><b>{pair[1]}</b></div>;
                        })}
                      </div>
                    </div>
                  )}

                  {/* Navigation buttons */}
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:20}}>
                    <button onClick={function(){setAppStep(function(p){return Math.max(1,p-1);});}} style={{...S.btn("secondary"),opacity:appStep===1?0.4:1}} disabled={appStep===1}>← Previous</button>
                    {appStep<4 ? (
                      <button onClick={function(){setAppStep(function(p){return p+1;});}} style={S.btn()}>Next →</button>
                    ) : (
                      <button onClick={submitApplication} disabled={!appForm.declaration||submitting} style={{...S.btn("green"),opacity:(!appForm.declaration||submitting)?0.5:1}}>
                        {submitting?"⏳ Submitting...":"📤 Submit Application"}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


// ══════════════════════════════════════════════════════
// EXAMS & ASSESSMENT MODULE
// Theory + Objective questions
// Manual marking → auto-push to Results
// CBT toggle (ready for AssanCBT integration)
// Score flows to CA1 / CA2 / Exam column
// ══════════════════════════════════════════════════════
function ExamModule({students, results, setResults, settings, currentUser, exams, setExams, examMarks, setExamMarks, cbtEnabled, setCbtEnabled}){
  var _tab = useState("exams"); var tab = _tab[0]; var setTab = _tab[1];
  var _showCreate = useState(false); var showCreate = _showCreate[0]; var setShowCreate = _showCreate[1];
  var _marking = useState(null); var marking = _marking[0]; var setMarking = _marking[1];
  var _search = useState(""); var search = _search[0]; var setSearch = _search[1];
  var _reportExam = useState(null); var reportExam = _reportExam[0]; var setReportExam = _reportExam[1];
  var _reportRows = useState([]); var reportRows = _reportRows[0]; var setReportRows = _reportRows[1];
  var _reportLoading = useState(false); var reportLoading = _reportLoading[0]; var setReportLoading = _reportLoading[1];

  var isAdmin = currentUser.role==="root"||currentUser.role==="admin"||currentUser.role==="Admin";

  // ── Exam creation form ────────────────────────────
  var emptyExam = {
    title:"", class:"JSS1", arm:"A", subject:"", session:CURRENT_SESSION,
    term:CURRENT_TERM, date:today(), duration:60,
    column:"ca1", type:"theory",
    totalMarks:100, questions:[], status:"Draft",
    cbtActive:false, manualEntryActive:true
  };
  var _form = useState(emptyExam); var form = _form[0]; var setForm = _form[1];

  // Question being added
  var emptyQ = {text:"", marks:5, type:"theory", optionA:"", optionB:"", optionC:"", optionD:"", answer:"A", image:""};
  var _newQ = useState(emptyQ); var newQ = _newQ[0]; var setNewQ = _newQ[1];
  var _editingQ = useState(null); var editingQ = _editingQ[0]; var setEditingQ = _editingQ[1];

  var rc = getResultConfig(settings);
  var COLUMN_LABELS = {ca1:"CA1 (max "+rc.ca1Max+")",ca2:"CA2 (max "+rc.ca2Max+")",exam:"Exam (max "+rc.examMax+")"};
  var COLUMN_MAX = {ca1:rc.ca1Max,ca2:rc.ca2Max,exam:rc.examMax};
  var ARMS = ["A","B","C","D","E"];

  // ── Add/edit question ─────────────────────────────
  function addQuestion(){
    if(!newQ.text.trim()) return alert("Question text is required.");
    if(newQ.type==="objective"&&(!newQ.optionA||!newQ.optionB)) return alert("Options A and B are required for objective questions.");
    var q = {...newQ, id:genId()};
    if(editingQ){
      setForm(function(p){return{...p,questions:p.questions.map(function(x){return x.id===editingQ?q:x;})};});
      setEditingQ(null);
    } else {
      setForm(function(p){return{...p,questions:[...p.questions,q]};});
    }
    setNewQ(emptyQ);
  }

  function removeQuestion(id){
    setForm(function(p){return{...p,questions:p.questions.filter(function(q){return q.id!==id;})};});
  }

  function editQuestion(q){
    setNewQ({...q});
    setEditingQ(q.id);
  }

  function saveExam(){
    if(!form.title.trim()) return alert("Exam title is required.");
    if(!form.subject) return alert("Please select a subject.");
    if(!form.questions.length) return alert("Add at least one question.");
    var totalMarks = form.questions.reduce(function(a,q){return a+(parseFloat(q.marks)||0);},0);
    var exam = {...form, id:genId(), totalMarks:totalMarks, createdBy:currentUser.name, createdAt:today()};
    setExams(function(p){return[exam,...p];});
    setShowCreate(false);
    setForm(emptyExam);
  }

  // ── Marking: push score to Results ────────────────
  function getExamMarksForStudent(examId, studentId){
    var key = examId+"_"+studentId;
    return examMarks[key] || {};
  }

  function setStudentQuestionMark(examId, studentId, questionId, value){
    var key = examId+"_"+studentId;
    setExamMarks(function(p){
      var current = p[key]||{};
      return {...p,[key]:{...current,[questionId]:parseFloat(value)||0}};
    });
  }

  function calcStudentTotal(exam, studentId){
    var marks = getExamMarksForStudent(exam.id, studentId);
    var raw = exam.questions.reduce(function(a,q){return a+(marks[q.id]||0);},0);
    // Scale to column max
    var colMax = COLUMN_MAX[exam.column]||60;
    if(exam.totalMarks && exam.totalMarks!==colMax){
      return Math.round((raw/exam.totalMarks)*colMax*10)/10;
    }
    return raw;
  }

  function pushAllScoresToResults(exam){
    var classStudents = students.filter(function(s){return s.active&&s.class===exam.class&&(s.arm||"A")===exam.arm;});
    var pushed = 0;
    classStudents.forEach(function(stu){
      var score = calcStudentTotal(exam, stu.id);
      if(score===0) return; // Skip unmarked
      // Find or create result record
      var existing = results.find(function(r){
        return r.studentId===stu.id && r.subject===exam.subject &&
          r.session===exam.session && r.term===exam.term && r.class===exam.class;
      });
      if(existing){
        setResults(function(p){return p.map(function(r){
          if(r.id!==existing.id) return r;
          var updated = {...r, [exam.column]:Math.round(score)};
          updated.total = (updated.ca1||0)+(updated.ca2||0)+(updated.exam||0);
          return updated;
        });});
      } else {
        var newR = {
          id:genId(), studentId:stu.id, subject:exam.subject,
          class:exam.class, arm:exam.arm, session:exam.session, term:exam.term,
          ca1:0, ca2:0, exam:0, total:0,
          affectiveTraits:{}, psychomotorSkills:{},
          teacherComment:"", formMasterComment:"", principalComment:""
        };
        newR[exam.column] = Math.round(score);
        newR.total = (newR.ca1||0)+(newR.ca2||0)+(newR.exam||0);
        setResults(function(p){return[...p,newR];});
      }
      pushed++;
    });
    alert("✅ Scores pushed to Results for "+pushed+" student(s) under "+COLUMN_LABELS[exam.column]+".");
    // Mark exam as marked
    setExams(function(p){return p.map(function(e){return e.id===exam.id?{...e,status:"Marked"}:e;});});
  }

  // ── CBT anti-cheat report — suspicion-scored attempt list ──
  function loadCbtReport(exam){
    setReportExam(exam);
    setReportRows([]);
    setReportLoading(true);
    fetch("/api/exam", {
      method:"POST",
      headers:authFetchHeaders(),
      body:JSON.stringify({action:"report", examId:exam.id})
    }).then(function(r){return r.json();}).then(function(res){
      setReportLoading(false);
      if(res.error) return alert(res.error);
      setReportRows(res.attempts||[]);
    }).catch(function(e){ setReportLoading(false); alert("Could not load report: "+e.message); });
  }

  var FLAG_COLOR = {high:"red",medium:"yellow",low:"blue",none:"green"};

  function renderCbtReportView(){
    return(
      <div>
        <button style={{...S.btn("secondary"),fontSize:11,marginBottom:14}} onClick={function(){setTab("exams");setReportExam(null);}}>← Back to Exams</button>
        {reportExam&&<div style={{...S.card,marginBottom:14,background:"#F5F3FB"}}>
          <div style={{fontSize:14,fontWeight:700,color:C.primaryDark}}>📊 CBT Anti-Cheat Report — {reportExam.title}</div>
          <div style={{fontSize:11,color:C.textMuted,marginTop:4}}>{reportExam.subject} · {reportExam.class}{reportExam.arm} · Paste attempts weighted ×3, tab switches ×1. High ≥15, Medium ≥6, Low ≥1.</div>
        </div>}
        {reportLoading?(
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>Loading report...</div>
        ):reportRows.length===0?(
          <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:32}}>No CBT attempts recorded for this exam yet.</div>
        ):(
          <div>
            <TableActionBar
              title={"CBT Report - "+(reportExam?reportExam.title:"")}
              columns={["Student","Adm No.","Status","Duration (min)","Tab Switches","Paste Attempts","Score","Suspicion","Flag"]}
              rows={reportRows.map(function(r){return [r.studentName,r.admissionNumber,r.status,r.durationMinutes==null?"—":r.durationMinutes,r.tabSwitches,r.pasteAttempts,(r.score==null?"—":r.score+"/"+r.maxScore),r.suspicionScore,r.flagLevel];})}
              filename={"CBT_Report_"+(reportExam?reportExam.title:"exam")}
            />
            <table style={S.table}><thead><tr>
              {["Student","Adm No.","Status","Duration","Tab Switches","Paste Attempts","Score","Suspicion","Flag"].map(function(h){return <th key={h} style={S.th}>{h}</th>;})}
            </tr></thead>
            <tbody>
              {reportRows.map(function(r){
                return(
                  <tr key={r.attemptId}>
                    <td style={S.td}>{r.studentName}</td>
                    <td style={S.td}>{r.admissionNumber}</td>
                    <td style={S.td}><span style={S.badge(r.status==="submitted"?"green":r.status==="in progress"?"yellow":"red")}>{r.status}</span></td>
                    <td style={S.td}>{r.durationMinutes==null?"—":r.durationMinutes+" min"}</td>
                    <td style={S.td}>{r.tabSwitches}</td>
                    <td style={S.td}>{r.pasteAttempts}</td>
                    <td style={S.td}>{r.score==null?"—":r.score+"/"+r.maxScore}</td>
                    <td style={S.td}>{r.suspicionScore}</td>
                    <td style={S.td}><span style={S.badge(FLAG_COLOR[r.flagLevel])}>{r.flagLevel}</span></td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ── Print exam paper ──────────────────────────────
  function printExamPaper(exam){
    var hdr = buildDocHeader(settings, exam.title.toUpperCase());
    var theoryQs = exam.questions.filter(function(q){return q.type==="theory";});
    var objQs = exam.questions.filter(function(q){return q.type==="objective";});
    var theorySection = theoryQs.length ? '<div style="margin-bottom:16px;"><div style="font-weight:700;margin-bottom:8px;border-bottom:1px solid #000;padding-bottom:4px;">SECTION A — THEORY ('+theoryQs.reduce(function(a,q){return a+(parseFloat(q.marks)||0);},0)+' marks)</div>'+theoryQs.map(function(q,i){return '<div style="margin-bottom:14px;"><div style="font-weight:600;">'+(i+1)+'. '+q.text+'<span style="float:right;color:#8B0000;">['+q.marks+' marks]</span></div><div style="margin-top:6px;border-bottom:1px solid #ddd;min-height:30px;"></div><div style="border-bottom:1px solid #ddd;min-height:30px;"></div></div>';}).join("")+'</div>' : '';
    var objSection = objQs.length ? '<div><div style="font-weight:700;margin-bottom:8px;border-bottom:1px solid #000;padding-bottom:4px;">SECTION B — OBJECTIVE ('+objQs.reduce(function(a,q){return a+(parseFloat(q.marks)||0);},0)+' marks)</div>'+objQs.map(function(q,i){return '<div style="margin-bottom:10px;"><div style="font-weight:600;">'+(theoryQs.length+i+1)+'. '+q.text+'<span style="float:right;color:#8B0000;">['+q.marks+' marks]</span></div><div style="display:flex;gap:20px;margin-top:4px;font-size:11px;"><span>A. '+q.optionA+'</span><span>B. '+q.optionB+'</span>'+(q.optionC?'<span>C. '+q.optionC+'</span>':'')+(q.optionD?'<span>D. '+q.optionD+'</span>':'')+'</div></div>';}).join("")+'</div>' : '';
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>'+exam.title+'</title><style>'+hdr.printStyles+'body{max-width:700px;margin:0 auto;}.info-row{display:flex;gap:20px;font-size:11px;border:1px solid #ccc;padding:8px;margin-bottom:12px;}</style></head><body>'+hdr.headerHtml+
      '<div class="info-row"><span><b>Class:</b> '+exam.class+exam.arm+'</span><span><b>Subject:</b> '+exam.subject+'</span><span><b>Date:</b> '+formatDate(exam.date)+'</span><span><b>Duration:</b> '+exam.duration+' minutes</span><span><b>Total Marks:</b> '+exam.totalMarks+'</span></div>'+
      '<div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:11px;"><span>Name: ___________________________</span><span>Adm No: ____________</span><span>Score: ________/'+exam.totalMarks+'</span></div>'+
      '<div style="font-size:10px;color:#666;margin-bottom:12px;">Answer ALL questions. Write clearly and legibly.</div>'+
      theorySection+objSection+hdr.footerHtml+'</body></html>';
    var w=window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.print();}
  }

  // ── Print marking guide ───────────────────────────
  function printMarkingGuide(exam){
    var hdr = buildDocHeader(settings, "MARKING GUIDE — "+exam.title.toUpperCase());
    var rows = exam.questions.map(function(q,i){
      return '<tr><td style="font-weight:700;">'+(i+1)+'</td><td>'+q.text+'</td><td style="text-align:center;font-weight:700;color:#8B0000;">'+q.marks+'</td><td style="color:#059669;font-weight:700;">'+(q.type==="objective"?"Option "+q.answer:q.answer||"See rubric")+'</td></tr>';
    }).join("");
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Marking Guide</title><style>'+hdr.printStyles+'</style></head><body>'+hdr.headerHtml+
      '<p style="font-size:11px;color:red;font-weight:700;margin-bottom:10px;">CONFIDENTIAL — FOR EXAMINER ONLY</p>'+
      '<table><thead><tr><th>#</th><th>Question</th><th>Marks</th><th>Expected Answer</th></tr></thead><tbody>'+rows+'</tbody></table>'+
      '<div style="margin-top:12px;font-size:10px;"><b>Total Marks: '+exam.totalMarks+'</b> | Column: '+COLUMN_LABELS[exam.column]+'</div>'+
      hdr.footerHtml+'</body></html>';
    var w=window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.print();}
  }

  // ── Print marking sheet ───────────────────────────
  function printMarkingSheet(exam){
    var hdr = buildDocHeader(settings, "MARKING SHEET — "+exam.title.toUpperCase());
    var classStudents = students.filter(function(s){return s.active&&s.class===exam.class&&(s.arm||"A")===exam.arm;});
    var qHeaders = exam.questions.map(function(q,i){return '<th style="min-width:40px;font-size:9px;">Q'+(i+1)+'<br/>('+q.marks+')</th>';}).join("");
    var rows = classStudents.map(function(s,i){
      var qCells = exam.questions.map(function(){return '<td></td>';}).join("");
      return '<tr><td>'+(i+1)+'</td><td style="font-weight:600;">'+s.surname+' '+s.firstname+'</td><td>'+s.admissionNo+'</td>'+qCells+'<td></td><td></td></tr>';
    }).join("");
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Marking Sheet</title><style>'+hdr.printStyles+'table{font-size:9px;}th,td{padding:4px;border:1px solid #ddd;text-align:center;}td:nth-child(2){text-align:left;}</style></head><body>'+hdr.headerHtml+
      '<p style="font-size:10px;margin-bottom:8px;"><b>Subject:</b> '+exam.subject+' | <b>Class:</b> '+exam.class+exam.arm+' | <b>Date:</b> '+formatDate(exam.date)+' | <b>Total Marks:</b> '+exam.totalMarks+'</p>'+
      '<table><thead><tr><th>#</th><th style="min-width:130px;text-align:left;">Student Name</th><th>Adm No.</th>'+qHeaders+'<th>Total/'+exam.totalMarks+'</th><th>Scaled/'+COLUMN_MAX[exam.column]+'</th></tr></thead><tbody>'+rows+'</tbody></table>'+
      hdr.footerHtml+'</body></html>';
    var w=window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.print();}
  }

  var filtered = exams.filter(function(e){
    return !search||(e.title+e.subject+e.class).toLowerCase().includes(search.toLowerCase());
  });

  // ── MARKING VIEW ─────────────────────────────────
  function renderMarkingView(){
    var exam = marking;
    var classStudents = students.filter(function(s){return s.active&&s.class===exam.class&&(s.arm||"A")===exam.arm;}).sort(function(a,b){return (a.surname+a.firstname).localeCompare(b.surname+b.firstname);});
    var theoryQs = exam.questions.filter(function(q){return q.type==="theory";});
    var objQs = exam.questions.filter(function(q){return q.type==="objective";});

    return(
      <div>
        <div style={{...S.card,marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8,alignItems:"center"}}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:C.primaryDark}}>{exam.title}</div>
              <div style={{fontSize:12,color:C.textMuted}}>{exam.class}{exam.arm} · {exam.subject} · {COLUMN_LABELS[exam.column]} · {exam.questions.length} questions · {exam.totalMarks} marks total</div>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button onClick={function(){printMarkingSheet(exam);}} style={{...S.btn("secondary"),fontSize:11}}>🖨 Marking Sheet</button>
              <button onClick={function(){pushAllScoresToResults(exam);}} style={{...S.btn("green"),fontSize:11}}>📊 Push Scores to Results</button>
              <button onClick={function(){setMarking(null);}} style={{...S.btn("secondary"),fontSize:11}}>← Back</button>
            </div>
          </div>
        </div>

        {/* Marking grid */}
        <div style={{...S.card,overflowX:"auto"}}>
          <table style={{...S.table,fontSize:11}}>
            <thead>
              <tr>
                <th style={{...S.th,minWidth:130,textAlign:"left",position:"sticky",left:0,background:"#230E6A"}}>Student</th>
                {theoryQs.length>0&&<th style={{...S.th,background:"#1D4ED8",minWidth:60}} colSpan={theoryQs.length}>THEORY ({theoryQs.reduce(function(a,q){return a+(parseFloat(q.marks)||0);},0)} marks)</th>}
                {objQs.length>0&&<th style={{...S.th,background:"#D97706",minWidth:60}} colSpan={objQs.length}>OBJECTIVE ({objQs.reduce(function(a,q){return a+(parseFloat(q.marks)||0);},0)} marks)</th>}
                <th style={{...S.thC,background:"#059669",minWidth:70}}>Raw Total</th>
                <th style={{...S.thC,background:"#230E6A",minWidth:70}}>→ {COLUMN_LABELS[exam.column]}</th>
              </tr>
              <tr>
                <th style={{...S.th,position:"sticky",left:0,background:"#230E6A"}}></th>
                {exam.questions.map(function(q,i){
                  return <th key={q.id} style={{...S.thC,fontSize:9,background:q.type==="theory"?"#EFF6FF":"#FFF7ED",color:"#374151",minWidth:60}}>
                    Q{i+1}<br/><span style={{color:C.textMuted}}>/{q.marks}</span>
                    {q.type==="objective"&&<div style={{fontSize:8,color:C.success}}>Ans:{q.answer}</div>}
                  </th>;
                })}
                <th style={S.thC}></th>
                <th style={S.thC}></th>
              </tr>
            </thead>
            <tbody>
              {classStudents.map(function(stu){
                var stuMarks = getExamMarksForStudent(exam.id, stu.id);
                var rawTotal = exam.questions.reduce(function(a,q){return a+(stuMarks[q.id]||0);},0);
                var scaled = calcStudentTotal(exam, stu.id);
                return(
                  <tr key={stu.id}>
                    <td style={{...S.td,fontWeight:600,position:"sticky",left:0,background:"#fff"}}>{stu.surname} {stu.firstname}</td>
                    {exam.questions.map(function(q){
                      var val = stuMarks[q.id]||"";
                      var maxMark = parseFloat(q.marks)||0;
                      // Objective: auto-mark if answer matches
                      if(q.type==="objective"){
                        return(
                          <td key={q.id} style={{...S.tdC,background:"#FFFBEB"}}>
                            <select style={{...S.select,width:60,padding:"2px",fontSize:10,textAlign:"center"}} value={stuMarks[q.id]!==undefined?stuMarks[q.id]:""} onChange={function(e){setStudentQuestionMark(exam.id,stu.id,q.id,e.target.value);}}>
                              <option value="">—</option>
                              <option value={maxMark}>✓ {maxMark}</option>
                              <option value={0}>✗ 0</option>
                              {maxMark>1&&<option value={maxMark*0.5}>½</option>}
                            </select>
                          </td>
                        );
                      }
                      return(
                        <td key={q.id} style={S.tdC}>
                          <input type="number" min="0" max={maxMark} style={{...S.input,width:54,padding:"2px 4px",textAlign:"center",fontSize:11,borderColor:val>maxMark?"#DC2626":"#E5E7EB"}} value={val} onChange={function(e){setStudentQuestionMark(exam.id,stu.id,q.id,Math.min(parseFloat(e.target.value)||0,maxMark));}} placeholder="0"/>
                        </td>
                      );
                    })}
                    <td style={{...S.tdC,fontWeight:700,color:rawTotal>0?C.primary:C.textMuted}}>{rawTotal||"—"}</td>
                    <td style={{...S.tdC,fontWeight:800,fontSize:13,color:scaled>=(COLUMN_MAX[exam.column]*0.4)?C.success:C.danger}}>{scaled||"—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Quick auto-mark for objective questions */}
        {objQs.length>0&&(
          <div style={{...S.card,marginTop:14,background:"#FFF7ED",border:"1px solid #F59E0B"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#D97706",marginBottom:8}}>⚡ Auto-mark Objective Questions</div>
            <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>For each student, enter their answer for each objective question. The system will automatically award full marks or zero based on the correct answer set during exam creation.</div>
            <div style={{overflowX:"auto"}}>
              <table style={{...S.table,fontSize:11}}>
                <thead>
                  <tr>
                    <th style={{...S.th,minWidth:120}}>Student</th>
                    {objQs.map(function(q,i){return <th key={q.id} style={{...S.thC,minWidth:70,background:"#D97706"}}>Q{theoryQs.length+i+1}<br/><span style={{fontSize:9}}>Ans:{q.answer}</span></th>;})}
                  </tr>
                </thead>
                <tbody>
                  {classStudents.map(function(stu){
                    return(
                      <tr key={stu.id}>
                        <td style={{...S.td,fontWeight:600}}>{stu.surname} {stu.firstname}</td>
                        {objQs.map(function(q){
                          var stuAnswer = (getExamMarksForStudent(exam.id+"_answers",stu.id)||{})[q.id]||"";
                          return(
                            <td key={q.id} style={S.tdC}>
                              <select style={{...S.select,width:60,padding:"2px",fontSize:10}} value={stuAnswer} onChange={function(e){
                                var ans = e.target.value;
                                // Store answer
                                setExamMarks(function(p){
                                  var aKey = exam.id+"_answers_"+stu.id;
                                  return {...p,[aKey]:{...(p[aKey]||{}),[q.id]:ans}};
                                });
                                // Auto-mark
                                var score = ans.toUpperCase()===q.answer.toUpperCase() ? (parseFloat(q.marks)||0) : 0;
                                setStudentQuestionMark(exam.id, stu.id, q.id, score);
                              }}>
                                <option value="">—</option>
                                {["A","B","C","D"].filter(function(opt){return q["option"+opt];}).map(function(opt){
                                  return <option key={opt} value={opt} style={{background:opt===q.answer?"#D1FAE5":""}}>
                                    {opt}: {q["option"+opt].slice(0,20)}{q["option"+opt].length>20?"...":""}
                                  </option>;
                                })}
                              </select>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  return(
    <div>
      {/* CBT Global Toggle */}
      <div style={{...S.card,marginBottom:14,background:cbtEnabled?"#F0FDF4":"#FFF7ED",border:"2px solid "+(cbtEnabled?"#059669":"#D97706")}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:cbtEnabled?"#059669":"#D97706"}}>
              {cbtEnabled?"🟢 CBT Mode ACTIVE":"🟡 Manual Marking Mode ACTIVE"}
            </div>
            <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>
              {cbtEnabled
                ?"CBT is ON — Computer based exams are available. Manual score entry is suspended for CBT exams."
                :"CBT is OFF — All marking is done manually by teachers. Scores are entered question by question."}
            </div>
          </div>
          {isAdmin&&(
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{fontSize:12,fontWeight:600}}>CBT Available:</span>
              <button onClick={function(){setCbtEnabled(function(p){return !p;});}} style={{
                background:cbtEnabled?"#059669":"#E5E7EB",
                border:"none",borderRadius:20,width:48,height:26,cursor:"pointer",
                position:"relative",transition:"background 0.3s"
              }}>
                <div style={{position:"absolute",top:3,left:cbtEnabled?24:3,width:20,height:20,background:"#fff",borderRadius:"50%",transition:"left 0.3s",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}/>
              </button>
              <span style={{fontSize:11,color:cbtEnabled?"#059669":"#6B7280",fontWeight:600}}>{cbtEnabled?"ON":"OFF"}</span>
            </div>
          )}
        </div>
        {cbtEnabled&&(
          <div style={{marginTop:10,padding:"8px 12px",background:"rgba(5,150,105,0.08)",borderRadius:6,fontSize:11,color:"#065F46"}}>
            🔗 <b>AssanCBT Integration Ready.</b> When AssanCBT portal is connected, objective exam scores will flow automatically into this module and push to Results. Until then, objective answers can be entered in the marking grid below.
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"2px solid "+C.border}}>
        {[["exams","📝 All Exams"],["marking","✏️ Mark Exam"]].map(function(pair){
          return <button key={pair[0]} onClick={function(){setTab(pair[0]);setMarking(null);}} style={{...S.btn(tab===pair[0]?"primary":"secondary"),borderRadius:"6px 6px 0 0",marginBottom:-2,fontSize:11,padding:"6px 14px"}}>{pair[1]}</button>;
        })}
        {isAdmin&&<button onClick={function(){setShowCreate(true);setForm(emptyExam);}} style={{...S.btn("green"),marginLeft:"auto",fontSize:11,marginBottom:4}}>+ Create Exam</button>}
      </div>

      {/* Marking view */}
      {marking ? renderMarkingView() : tab==="cbtreport" ? renderCbtReportView() : (
        <div>
          {/* Search */}
          <div style={{...S.card,marginBottom:14}}>
            <input style={{...S.input,width:"100%"}} placeholder="Search exams by title, subject or class..." value={search} onChange={function(e){setSearch(e.target.value);}}/>
          </div>

          {/* Exam cards */}
          {filtered.length===0 ? (
            <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:48}}>
              <div style={{fontSize:40,marginBottom:10}}>📝</div>
              <div style={{fontSize:14,fontWeight:600}}>No exams yet</div>
              {isAdmin&&<div style={{fontSize:12,marginTop:6}}>Click "+ Create Exam" to set up your first exam with theory and objective questions.</div>}
            </div>
          ) : (
            filtered.map(function(exam){
              var theoryCount = exam.questions.filter(function(q){return q.type==="theory";}).length;
              var objCount = exam.questions.filter(function(q){return q.type==="objective";}).length;
              var classStudents = students.filter(function(s){return s.active&&s.class===exam.class&&(s.arm||"A")===exam.arm;}).length;
              return(
                <div key={exam.id} style={{...S.card,marginBottom:12,borderLeft:"4px solid "+(exam.status==="Marked"?C.success:exam.status==="Active"?"#D97706":C.primary)}}>
                  <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
                    <div style={{flex:1}}>
                      <div style={{...S.row,gap:8,marginBottom:6}}>
                        <span style={{fontSize:14,fontWeight:700,color:C.primaryDark}}>{exam.title}</span>
                        <span style={S.badge(exam.status==="Marked"?"green":exam.status==="Active"?"yellow":"blue")}>{exam.status}</span>
                        <span style={S.badge("yellow")}>{COLUMN_LABELS[exam.column]}</span>
                        {exam.cbtActive&&<span style={S.badge("green")}>CBT Active</span>}
                      </div>
                      <div style={{display:"flex",gap:16,flexWrap:"wrap",fontSize:11,color:C.textMuted}}>
                        <span>📚 {exam.subject}</span>
                        <span>🏫 {exam.class}{exam.arm}</span>
                        <span>📅 {formatDate(exam.date)}</span>
                        <span>⏱ {exam.duration} mins</span>
                        <span>📝 {exam.totalMarks} marks</span>
                        <span>👥 {classStudents} students</span>
                        {theoryCount>0&&<span>Theory: {theoryCount}Q</span>}
                        {objCount>0&&<span>Objective: {objCount}Q</span>}
                      </div>
                    </div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"flex-start"}}>
                      <button onClick={function(){printExamPaper(exam);}} style={{...S.btn("secondary"),fontSize:10,padding:"4px 10px"}}>🖨 Paper</button>
                      <button onClick={function(){printMarkingGuide(exam);}} style={{...S.btn("secondary"),fontSize:10,padding:"4px 10px"}}>🗝 Guide</button>
                      <button onClick={function(){setMarking(exam);setTab("marking");}} style={{...S.btn("blue"),fontSize:10,padding:"4px 10px"}}>✏️ Mark</button>
                      {exam.cbtActive&&<button onClick={function(){loadCbtReport(exam);setTab("cbtreport");}} style={{...S.btn("gold"),fontSize:10,padding:"4px 10px"}}>📊 CBT Report</button>}
                      {isAdmin&&(
                        <button onClick={function(){
                          setExams(function(p){return p.map(function(e){
                            if(e.id!==exam.id) return e;
                            return {...e,cbtActive:!e.cbtActive,manualEntryActive:e.cbtActive};
                          });});
                        }} style={{...S.btn(exam.cbtActive?"green":"secondary"),fontSize:10,padding:"4px 10px"}}>
                          {exam.cbtActive?"CBT ON":"CBT OFF"}
                        </button>
                      )}
                      {isAdmin&&<button onClick={function(){if(window.confirm("Delete this exam?"))setExams(function(p){return p.filter(function(e){return e.id!==exam.id;});});}} style={{...S.btn("danger"),fontSize:10,padding:"4px 10px"}}>🗑</button>}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── CREATE EXAM MODAL ── */}
      {showCreate&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,overflowY:"auto",padding:20}}>
          <div style={{maxWidth:800,margin:"0 auto",background:"#fff",borderRadius:14,overflow:"hidden"}}>
            {/* Modal header */}
            <div style={{background:"linear-gradient(120deg,#230E6A,#D97706)",padding:"16px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:15,fontWeight:900,color:"#fff"}}>Create New Exam</div>
              <button onClick={function(){setShowCreate(false);}} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",padding:"5px 12px",borderRadius:6,cursor:"pointer"}}>✕</button>
            </div>

            <div style={{padding:"20px 24px"}}>
              {/* Exam details */}
              <div style={{fontSize:12,fontWeight:700,color:C.primaryDark,marginBottom:10}}>EXAM DETAILS</div>
              <div style={S.grid2}>
                <div style={{...S.formGroup,gridColumn:"1/-1"}}><label style={S.label}>Exam Title *</label><input style={S.input} value={form.title} onChange={function(e){setForm(function(p){return{...p,title:e.target.value};});}} placeholder="e.g. First Term Mid-Term Mathematics Examination"/></div>
                <div style={S.formGroup}><label style={S.label}>Class *</label><select style={{...S.select,width:"100%"}} value={form.class} onChange={function(e){setForm(function(p){return{...p,class:e.target.value};});}}>{CLASSES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
                <div style={S.formGroup}><label style={S.label}>Arm</label><select style={{...S.select,width:"100%"}} value={form.arm} onChange={function(e){setForm(function(p){return{...p,arm:e.target.value};});}}>{ARMS.map(function(a){return <option key={a}>{a}</option>;})}</select></div>
                <div style={S.formGroup}><label style={S.label}>Subject *</label><select style={{...S.select,width:"100%"}} value={form.subject} onChange={function(e){setForm(function(p){return{...p,subject:e.target.value};});}}><option value="">— Select —</option>{getSubjects(form.class).map(function(s){return <option key={s}>{s}</option>;})}</select></div>
                <div style={S.formGroup}><label style={S.label}>Score Column *</label><select style={{...S.select,width:"100%"}} value={form.column} onChange={function(e){setForm(function(p){return{...p,column:e.target.value};});}}>{Object.entries(COLUMN_LABELS).map(function(e){return <option key={e[0]} value={e[0]}>{e[1]}</option>;})}</select></div>
                <div style={S.formGroup}><label style={S.label}>Exam Date</label><input type="date" style={S.input} value={form.date} onChange={function(e){setForm(function(p){return{...p,date:e.target.value};});}}/></div>
                <div style={S.formGroup}><label style={S.label}>Duration (minutes)</label><input type="number" style={S.input} value={form.duration} onChange={function(e){setForm(function(p){return{...p,duration:e.target.value};});}} min="10" max="300"/></div>
                <div style={S.formGroup}><label style={S.label}>Session</label><select style={{...S.select,width:"100%"}} value={form.session} onChange={function(e){setForm(function(p){return{...p,session:e.target.value};});}}>{SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
                <div style={S.formGroup}><label style={S.label}>Term</label><select style={{...S.select,width:"100%"}} value={form.term} onChange={function(e){setForm(function(p){return{...p,term:e.target.value};});}}>{TERMS.map(function(t){return <option key={t}>{t}</option>;})}</select></div>
              </div>

              {/* Question builder */}
              <div style={{fontSize:12,fontWeight:700,color:C.primaryDark,marginTop:16,marginBottom:10,borderTop:"2px solid "+C.border,paddingTop:12}}>
                QUESTIONS ({form.questions.length} added · {form.questions.reduce(function(a,q){return a+(parseFloat(q.marks)||0);},0)} marks total)
              </div>

              {/* Existing questions */}
              {form.questions.length>0&&(
                <div style={{marginBottom:14,maxHeight:280,overflowY:"auto",border:"1px solid "+C.border,borderRadius:8}}>
                  {form.questions.map(function(q,i){
                    var isObj = q.type==="objective";
                    return(
                      <div key={q.id} style={{padding:"10px 14px",borderBottom:"1px solid "+C.border,background:isObj?"#FFFBEB":"#fff",display:"flex",gap:10,alignItems:"flex-start"}}>
                        <div style={{fontSize:11,fontWeight:700,color:C.textMuted,minWidth:24}}>{i+1}.</div>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,fontWeight:600,marginBottom:3}}>{q.text}</div>
                          {isObj&&<div style={{fontSize:10,color:C.textMuted}}>A:{q.optionA} B:{q.optionB}{q.optionC?" C:"+q.optionC:""}{q.optionD?" D:"+q.optionD:""} · <b style={{color:C.success}}>Ans:{q.answer}</b></div>}
                          <div style={{fontSize:10,color:C.textMuted,marginTop:2}}>
                            <span style={S.badge(isObj?"yellow":"blue")}>{isObj?"Objective":"Theory"}</span>
                            <span style={{marginLeft:6}}>{q.marks} mark{q.marks!==1?"s":""}</span>
                          </div>
                        </div>
                        <div style={{display:"flex",gap:4,flexShrink:0}}>
                          <button onClick={function(){editQuestion(q);}} style={{...S.btn("secondary"),fontSize:10,padding:"2px 8px"}}>Edit</button>
                          <button onClick={function(){removeQuestion(q.id);}} style={{...S.btn("danger"),fontSize:10,padding:"2px 8px"}}>✕</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Add question form */}
              <div style={{background:"#F9FAFB",border:"1px solid "+C.border,borderRadius:8,padding:"14px 16px",marginBottom:14}}>
                <div style={{fontSize:11,fontWeight:700,color:C.primaryDark,marginBottom:10}}>{editingQ?"Edit Question":"Add New Question"}</div>

                <div style={{display:"flex",gap:10,marginBottom:10}}>
                  <div style={S.formGroup}>
                    <label style={S.label}>Question Type</label>
                    <select style={S.select} value={newQ.type} onChange={function(e){setNewQ(function(p){return{...p,type:e.target.value};});}}>
                      <option value="theory">Theory (written answer)</option>
                      <option value="objective">Objective (A/B/C/D)</option>
                    </select>
                  </div>
                  <div style={S.formGroup}>
                    <label style={S.label}>Marks for this question</label>
                    <input type="number" style={S.input} value={newQ.marks} onChange={function(e){setNewQ(function(p){return{...p,marks:parseFloat(e.target.value)||1};});}} min="0.5" step="0.5"/>
                  </div>
                </div>

                <div style={S.formGroup}>
                  <label style={S.label}>Question Text *</label>
                  <textarea style={{...S.textarea,minHeight:60}} value={newQ.text} onChange={function(e){setNewQ(function(p){return{...p,text:e.target.value};});}} placeholder="Type the question here..."/>
                </div>

                {newQ.type==="objective"&&(
                  <div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                      {[["A","optionA"],["B","optionB"],["C","optionC"],["D","optionD"]].map(function(pair){
                        return <div key={pair[0]} style={S.formGroup}>
                          <label style={S.label}>Option {pair[0]} {pair[0]==="A"||pair[0]==="B"?"*":""}</label>
                          <input style={S.input} value={newQ[pair[1]]} onChange={function(e){setNewQ(function(p){return{...p,[pair[1]]:e.target.value};});}} placeholder={"Option "+pair[0]}/>
                        </div>;
                      })}
                    </div>
                    <div style={S.formGroup}>
                      <label style={S.label}>Correct Answer *</label>
                      <select style={{...S.select,background:"#F0FDF4",borderColor:"#059669"}} value={newQ.answer} onChange={function(e){setNewQ(function(p){return{...p,answer:e.target.value};});}}>
                        {["A","B","C","D"].filter(function(opt){return newQ["option"+opt];}).map(function(opt){return <option key={opt} value={opt}>Option {opt}: {newQ["option"+opt].slice(0,30)}</option>;})}
                      </select>
                    </div>
                  </div>
                )}

                {newQ.type==="theory"&&(
                  <div style={S.formGroup}>
                    <label style={S.label}>Expected Answer / Marking Guide (optional)</label>
                    <textarea style={{...S.textarea,minHeight:50}} value={newQ.answer} onChange={function(e){setNewQ(function(p){return{...p,answer:e.target.value};});}} placeholder="Key points expected in the student's answer (for teacher reference only)..."/>
                  </div>
                )}

                <button onClick={addQuestion} style={S.btn()}>{editingQ?"Update Question":"Add Question"}</button>
                {editingQ&&<button onClick={function(){setEditingQ(null);setNewQ(emptyQ);}} style={{...S.btn("secondary"),marginLeft:8}}>Cancel Edit</button>}
              </div>

              {/* Save exam */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:11,color:C.textMuted}}>
                  {form.questions.length} questions · {form.questions.reduce(function(a,q){return a+(parseFloat(q.marks)||0);},0)} marks total · Column: {COLUMN_LABELS[form.column]}
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={function(){setShowCreate(false);}} style={S.btn("secondary")}>Cancel</button>
                  <button onClick={saveExam} style={S.btn()}>💾 Save Exam</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ══════════════════════════════════════════════════════
// ADMISSION CANDIDATE PORTAL — public self-service application
// Fill Form (new/edit), Gallery, School Calendar. Scoped to exactly
// one application via a candidate token (see candidate-portal.js).
// ══════════════════════════════════════════════════════
function CandidatePortal({mode, candidateApp, justIssued, settings, gallery, submitting, onSubmitApplication, onUpdateApplication, onCancel, onLogout}){
  var _tab = useState("form"); var tab = _tab[0]; var setTab = _tab[1];
  var _appStep = useState(1); var appStep = _appStep[0]; var setAppStep = _appStep[1];

  var STATES = ["Osun","Lagos","Oyo","Ogun","Ondo","Ekiti","Kwara","Kogi","Abuja FCT","Others"];
  var HOW_HEARD = ["Word of mouth","Social media","School fair","Mosque/Church","Former student","Billboard","Others"];

  var emptyApp = {
    surname:"", firstname:"", middlename:"", dob:"", gender:"Male",
    religion:"Islam", bloodGroup:"O+", genotype:"AA", nationality:"Nigerian",
    stateOfOrigin:"Osun", lga:"",
    prevSchool:"", prevClass:"", prevSession:"",
    parentName:"", parentPhone:"", parentAlt:"", parentEmail:"",
    parentOccupation:"", parentAddress:"",
    applyingForClass:"JSS1", entrySession:CURRENT_SESSION,
    boardingType:"Day", howHeard:"",
    passport:"", birthCert:false, reportCard:false, testimonial:false,
    declaration:false
  };
  var _form = useState(candidateApp?{...emptyApp,...candidateApp}:emptyApp); var form = _form[0]; var setForm = _form[1];
  var editable = mode==="new" || (candidateApp&&candidateApp.status==="Pending");

  function submit(){
    if(!form.surname.trim()||!form.firstname.trim()) return alert("Student name is required.");
    if(!form.dob) return alert("Date of birth is required.");
    if(!form.parentName.trim()||!form.parentPhone.trim()) return alert("Parent/Guardian details are required.");
    if(!form.declaration) return alert("Please confirm the declaration to submit.");
    if(mode==="new") onSubmitApplication(form);
    else onUpdateApplication(form);
  }

  function renderFormSteps(){
    return(<div>
      {appStep===1&&(
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#230E6A",marginBottom:14}}>Student Information</div>
          <div style={{...S.formGroup,marginBottom:14}}>
            <label style={S.label}>Passport Photograph</label>
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              <div style={{width:80,height:80,borderRadius:8,overflow:"hidden",border:"2px solid "+C.border,background:"#F3F4F6",display:"flex",alignItems:"center",justifyContent:"center"}}>
                {form.passport?<img src={form.passport} style={{width:"100%",height:"100%",objectFit:"cover"}} alt=""/>:<span style={{fontSize:28}}>👤</span>}
              </div>
              {editable&&<div>
                <input type="file" accept="image/*" style={{fontSize:11}} onChange={function(e){var f=e.target.files[0];if(!f)return;if(f.size>41000)return alert("Photo must be under 40KB.");var r=new FileReader();r.onload=function(ev){setForm(function(p){return{...p,passport:ev.target.result};});};r.readAsDataURL(f);}}/>
                <div style={{fontSize:9,color:C.textMuted,marginTop:4}}>Max 40KB. Clear, frontal photo.</div>
              </div>}
            </div>
          </div>
          <div style={S.grid2}>
            <div style={S.formGroup}><label style={S.label}>Surname *</label><input disabled={!editable} style={S.input} value={form.surname} onChange={function(e){setForm(function(p){return{...p,surname:e.target.value};});}} placeholder="Family name"/></div>
            <div style={S.formGroup}><label style={S.label}>First Name *</label><input disabled={!editable} style={S.input} value={form.firstname} onChange={function(e){setForm(function(p){return{...p,firstname:e.target.value};});}} placeholder="First name"/></div>
            <div style={S.formGroup}><label style={S.label}>Middle Name</label><input disabled={!editable} style={S.input} value={form.middlename} onChange={function(e){setForm(function(p){return{...p,middlename:e.target.value};});}}/></div>
            <div style={{...S.formGroup,background:"#FEF3C7",borderRadius:8,padding:"6px 8px",border:"1px solid #F59E0B"}}><label style={{...S.label,color:"#92400E",fontWeight:800}}>📅 Date of Birth *</label><input disabled={!editable} type="date" style={{...S.input,borderColor:"#F59E0B"}} value={form.dob} onChange={function(e){setForm(function(p){return{...p,dob:e.target.value};});}}/></div>
            <div style={S.formGroup}><label style={S.label}>Gender</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.gender} onChange={function(e){setForm(function(p){return{...p,gender:e.target.value};});}}><option>Male</option><option>Female</option></select></div>
            <div style={S.formGroup}><label style={S.label}>Religion</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.religion} onChange={function(e){setForm(function(p){return{...p,religion:e.target.value};});}}><option>Islam</option><option>Christianity</option><option>Traditional</option></select></div>
            <div style={S.formGroup}><label style={S.label}>Blood Group</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.bloodGroup} onChange={function(e){setForm(function(p){return{...p,bloodGroup:e.target.value};});}}>{["O+","O-","A+","A-","B+","B-","AB+","AB-"].map(function(b){return <option key={b}>{b}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Genotype</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.genotype} onChange={function(e){setForm(function(p){return{...p,genotype:e.target.value};});}}>{["AA","AS","AC","SS","SC"].map(function(g){return <option key={g}>{g}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>State of Origin</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.stateOfOrigin} onChange={function(e){setForm(function(p){return{...p,stateOfOrigin:e.target.value};});}}>{STATES.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>L.G.A</label><input disabled={!editable} style={S.input} value={form.lga} onChange={function(e){setForm(function(p){return{...p,lga:e.target.value};});}}/></div>
          </div>
          <div style={{marginTop:12}}><label style={S.label}>Previous School</label><input disabled={!editable} style={S.input} value={form.prevSchool} onChange={function(e){setForm(function(p){return{...p,prevSchool:e.target.value};});}} placeholder="Name of last school attended (if any)"/></div>
        </div>
      )}
      {appStep===2&&(
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#230E6A",marginBottom:14}}>Parent / Guardian Information</div>
          <div style={S.grid2}>
            <div style={S.formGroup}><label style={S.label}>Full Name *</label><input disabled={!editable} style={S.input} value={form.parentName} onChange={function(e){setForm(function(p){return{...p,parentName:e.target.value};});}} placeholder="Parent/Guardian full name"/></div>
            <div style={S.formGroup}><label style={S.label}>Phone Number *</label><input disabled={!editable} style={S.input} type="tel" value={form.parentPhone} onChange={function(e){setForm(function(p){return{...p,parentPhone:e.target.value};});}} placeholder="08012345678"/></div>
            <div style={S.formGroup}><label style={S.label}>Alternative Phone</label><input disabled={!editable} style={S.input} type="tel" value={form.parentAlt} onChange={function(e){setForm(function(p){return{...p,parentAlt:e.target.value};});}}/></div>
            <div style={S.formGroup}><label style={S.label}>Email Address</label><input disabled={!editable} style={S.input} type="email" value={form.parentEmail} onChange={function(e){setForm(function(p){return{...p,parentEmail:e.target.value};});}}/></div>
            <div style={S.formGroup}><label style={S.label}>Occupation</label><input disabled={!editable} style={S.input} value={form.parentOccupation} onChange={function(e){setForm(function(p){return{...p,parentOccupation:e.target.value};});}}/></div>
          </div>
          <div style={S.formGroup}><label style={S.label}>Home Address *</label><textarea disabled={!editable} style={{...S.textarea,minHeight:60}} value={form.parentAddress} onChange={function(e){setForm(function(p){return{...p,parentAddress:e.target.value};});}} placeholder="Full residential address"/></div>
        </div>
      )}
      {appStep===3&&(
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#230E6A",marginBottom:14}}>Application Preferences</div>
          <div style={S.grid2}>
            <div style={S.formGroup}><label style={S.label}>Applying for Class *</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.applyingForClass} onChange={function(e){setForm(function(p){return{...p,applyingForClass:e.target.value};});}}>{CLASSES.map(function(c){return <option key={c}>{c}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Entry Session *</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.entrySession} onChange={function(e){setForm(function(p){return{...p,entrySession:e.target.value};});}}>{SESSIONS.map(function(s){return <option key={s}>{s}</option>;})}</select></div>
            <div style={S.formGroup}><label style={S.label}>Boarding Type</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.boardingType} onChange={function(e){setForm(function(p){return{...p,boardingType:e.target.value};});}}><option>Day</option><option>Boarder</option></select></div>
            <div style={S.formGroup}><label style={S.label}>How did you hear about us?</label><select disabled={!editable} style={{...S.select,width:"100%"}} value={form.howHeard} onChange={function(e){setForm(function(p){return{...p,howHeard:e.target.value};});}}><option value="">— Select —</option>{HOW_HEARD.map(function(h){return <option key={h}>{h}</option>;})}</select></div>
          </div>
          <div style={{...S.card,background:"#EFF6FF",marginTop:12}}>
            <div style={{fontSize:12,fontWeight:700,color:C.primary,marginBottom:10}}>Documents Checklist</div>
            {[["birthCert","Original Birth Certificate or Sworn Affidavit"],["reportCard","Last School Report Card"],["testimonial","School Testimonial / Transfer Certificate"]].map(function(pair){
              return <label key={pair[0]} style={{display:"flex",gap:8,alignItems:"center",marginBottom:8,cursor:editable?"pointer":"default",fontSize:12}}>
                <input disabled={!editable} type="checkbox" checked={form[pair[0]]||false} onChange={function(){setForm(function(p){return{...p,[pair[0]]:!p[pair[0]]};});}}/>
                {pair[1]}
              </label>;
            })}
          </div>
        </div>
      )}
      {appStep===4&&(
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#230E6A",marginBottom:14}}>Declaration &amp; Submission</div>
          <div style={{...S.card,background:"#F5F3FB",marginBottom:14}}>
            <div style={{fontSize:12,lineHeight:1.7}}>I, <b>{form.parentName||"____________________"}</b>, hereby declare that all information provided in this application is true and accurate to the best of my knowledge. I understand that the submission of false information may lead to the cancellation of this application or admission.</div>
          </div>
          <label style={{display:"flex",gap:8,alignItems:"flex-start",cursor:editable?"pointer":"default",fontSize:12,marginBottom:16}}>
            <input disabled={!editable} type="checkbox" style={{marginTop:2}} checked={form.declaration||false} onChange={function(){setForm(function(p){return{...p,declaration:!p.declaration};});}}/>
            <span>I confirm that the above declaration is true and I agree to the school's terms and conditions.</span>
          </label>
          <div style={{...S.card,background:"#F0FDF4"}}>
            <div style={{fontSize:12,fontWeight:700,color:C.success,marginBottom:8}}>Application Summary</div>
            {[["Student",form.surname+" "+form.firstname],["Date of Birth",form.dob?formatDate(form.dob):"—"],["Applying For",form.applyingForClass+" — "+form.entrySession],["Boarding",form.boardingType],["Parent",form.parentName],["Parent Phone",form.parentPhone]].map(function(pair,i){
              return <div key={i} style={{display:"flex",gap:8,padding:"3px 0",borderBottom:"1px solid #E5E7EB",fontSize:12}}><span style={{color:C.textMuted,minWidth:100}}>{pair[0]}:</span><b>{pair[1]}</b></div>;
            })}
          </div>
        </div>
      )}
      <div style={{display:"flex",justifyContent:"space-between",marginTop:20}}>
        <button onClick={function(){setAppStep(function(p){return Math.max(1,p-1);});}} style={{...S.btn("secondary"),opacity:appStep===1?0.4:1}} disabled={appStep===1}>← Previous</button>
        {appStep<4?(
          <button onClick={function(){setAppStep(function(p){return p+1;});}} style={S.btn()}>Next →</button>
        ):editable?(
          <button onClick={submit} disabled={!form.declaration||submitting} style={{...S.btn("green"),opacity:(!form.declaration||submitting)?0.5:1}}>{submitting?"⏳ Submitting...":mode==="new"?"📤 Submit Application":"💾 Save Changes"}</button>
        ):null}
      </div>
    </div>);
  }

  function renderStatusBanner(){
    if(!candidateApp) return null;
    var color = candidateApp.status==="Approved"||candidateApp.status==="Enrolled"?"#059669":candidateApp.status==="Rejected"?"#DC2626":"#D97706";
    return(
      <div style={{...S.card,marginBottom:14,borderLeft:"4px solid "+color}}>
        <div style={{...S.row,justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <div>
            <div style={{fontSize:11,color:C.textMuted}}>Reference No.</div>
            <div style={{fontSize:16,fontWeight:900,color:"#230E6A"}}>{candidateApp.refNo}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,color:C.textMuted}}>Status</div>
            <span style={S.badge(candidateApp.status==="Approved"||candidateApp.status==="Enrolled"?"green":candidateApp.status==="Rejected"?"red":"yellow")}>{candidateApp.status}</span>
          </div>
        </div>
        {candidateApp.remarks&&<div style={{marginTop:8,background:"#FFF7ED",borderRadius:6,padding:"8px 10px",fontSize:12}}><b>Remarks:</b> {candidateApp.remarks}</div>}
        {candidateApp.status==="Pending"&&<div style={{marginTop:8,fontSize:11,color:C.textMuted}}>Your application is being reviewed. You can still edit and re-save it below until a decision is made.</div>}
      </div>
    );
  }

  function renderGallery(){
    return(
      <div>
        <div style={{background:"linear-gradient(120deg,#230E6A,#059669)",borderRadius:12,padding:"16px 20px",marginBottom:14,color:"#fff"}}>
          <div style={{fontSize:16,fontWeight:800}}>🖼 School Gallery</div>
          <div style={{fontSize:11,opacity:0.8,marginTop:2}}>Take a look at school life before you apply</div>
        </div>
        <GalleryModule gallery={gallery||[]} setGallery={function(){}} currentUser={{name:"Applicant"}} readOnly={true}/>
      </div>
    );
  }

  function renderCalendar(){
    var events = (settings.calendarEvents||[]).slice().sort(function(a,b){return a.date.localeCompare(b.date);});
    var TYPE_COLOR = {Academic:"#1D4ED8", Exam:"#DC2626", Holiday:"#059669", Event:"#D97706", Others:"#6B7280"};
    return(
      <div>
        <SchoolCalendarWidget settings={settings}/>
        <div style={S.card}>
          <div style={S.cardTitle}>Full Academic Calendar</div>
          {events.length===0?<div style={{color:C.textMuted,fontSize:12,padding:12}}>No calendar events published yet.</div>:events.map(function(e){
            return(
              <div key={e.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid "+C.border}}>
                <div><div style={{fontSize:13,fontWeight:600}}>{e.title}</div><div style={{fontSize:11,color:C.textMuted}}>{formatDate(e.date)}</div></div>
                <span style={{background:TYPE_COLOR[e.type]||"#6B7280",color:"#fff",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700}}>{e.type}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  var NAV_TABS = [["form",mode==="new"?"📝 Fill Form":"📝 My Application"],["gallery","🖼 Gallery"],["calendar","📅 School Calendar"]];

  return(
    <div style={{minHeight:"100vh",background:"#F9FAFB",fontFamily:"'Segoe UI',sans-serif"}}>
      <div style={{background:"linear-gradient(90deg,#230E6A,#3D2496)",padding:"0 20px",display:"flex",alignItems:"center",justifyContent:"space-between",height:56,position:"sticky",top:0,zIndex:100}}>
        <div>
          <div style={{fontSize:12,fontWeight:800,color:"#F0C060"}}>{SCHOOL_NAME}</div>
          <div style={{fontSize:10,color:"rgba(255,255,255,0.6)"}}>Admission Applicant Portal</div>
        </div>
        <button onClick={mode==="new"?onCancel:onLogout} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:6,color:"#fff",padding:"4px 12px",cursor:"pointer",fontSize:11}}>{mode==="new"?"✕ Cancel":"Logout"}</button>
      </div>

      <div style={{background:"#fff",borderBottom:"1px solid #E5E7EB",padding:"0 20px",display:"flex",gap:0,overflowX:"auto"}}>
        {NAV_TABS.map(function(pair){
          var id=pair[0]; var label=pair[1];
          return <button key={id} onClick={function(){setTab(id);}} style={{background:"none",border:"none",borderBottom:tab===id?"3px solid #230E6A":"3px solid transparent",color:tab===id?"#230E6A":"#6B7280",fontWeight:tab===id?700:400,padding:"14px 16px",cursor:"pointer",fontSize:12,whiteSpace:"nowrap",fontFamily:"inherit"}}>{label}</button>;
        })}
      </div>

      <div style={{maxWidth:800,margin:"0 auto",padding:"20px 16px"}}>
        {tab==="form"&&(
          <div>
            {justIssued&&<div style={{...S.card,marginBottom:14,background:"#F0FDF4",border:"2px solid #059669",textAlign:"center",padding:20}}>
              <div style={{fontSize:28,marginBottom:6}}>🎉</div>
              <div style={{fontSize:14,fontWeight:800,color:"#059669"}}>Application Submitted!</div>
              <div style={{display:"flex",gap:20,justifyContent:"center",marginTop:12,flexWrap:"wrap"}}>
                <div><div style={{fontSize:10,color:C.textMuted}}>REFERENCE NO.</div><div style={{fontSize:18,fontWeight:900,color:"#230E6A"}}>{justIssued.refNo}</div></div>
                <div><div style={{fontSize:10,color:C.textMuted}}>PIN</div><div style={{fontSize:18,fontWeight:900,color:"#230E6A"}}>{justIssued.pin}</div></div>
              </div>
              <div style={{fontSize:11,color:C.textMuted,marginTop:10}}>⚠ Save these — you'll need both to check your application status later. They will not be shown again.</div>
            </div>}
            {mode!=="new"&&renderStatusBanner()}
            <div style={S.card}>{renderFormSteps()}</div>
          </div>
        )}
        {tab==="gallery"&&renderGallery()}
        {tab==="calendar"&&renderCalendar()}
      </div>
    </div>
  );
}

function LoginScreen({settings,onLogin,onParentLogin,onCandidateLogin,onStartApplication,gallery}){
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const [loginType,setLoginType]=useState("staff"); // "staff" | "parent" | "candidate"
  const [candidateMode,setCandidateMode]=useState("choose"); // "choose" | "login"
  const [slideIndex,setSlideIndex]=useState(0);

  // Flatten all gallery photos into one slideshow feed (most recent albums first)
  const slidePhotos = (gallery||[])
    .slice()
    .sort((a,b)=>b.date.localeCompare(a.date))
    .flatMap(album=>album.photos.map(p=>({...p, eventName:album.eventName})));

  useEffect(()=>{
    if(slidePhotos.length<2) return;
    const timer = setInterval(()=>{
      setSlideIndex(i=>(i+1)%slidePhotos.length);
    },4000);
    return ()=>clearInterval(timer);
  },[slidePhotos.length]);

  function login(){
    if(!username||!password)return setError("Please enter your credentials.");
    setLoading(true);
    if(loginType==="staff"){
      // Every staff/root login goes through the authenticated login endpoint —
      // it issues a signed session token that dbCall/adminCall attach to
      // every subsequent request. No credentials are ever checked client-side.
      setError("Verifying...");
      fetch("/api/login",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({username:username,password:password})
      }).then(function(r){return r.json();}).then(function(result){
        if(result.success&&result.admin&&result.token){
          setAuthToken(result.token);
          setError("");
          onLogin(result.admin);
        } else {
          setError(result.error==="Account deactivated"?"This account has been deactivated.":"Invalid username or password.");
          setLoading(false);
          setTimeout(function(){setError("");},4000);
        }
      }).catch(function(e){
        setError("Could not reach the server. Check your connection and try again.");
        setLoading(false);
        setTimeout(function(){setError("");},4000);
      });
      } else if(loginType==="parent"){
        // Parent login: admission number + parent phone
        if(onParentLogin){
          setError("Verifying...");
          Promise.resolve(onParentLogin(username.trim(), password.trim())).then(function(result){
            if(!result){setError("Admission number or phone number not found. Check and try again.");setLoading(false);setTimeout(()=>setError(""),5000);}
          });
        }
      } else if(loginType==="candidate"){
        // Candidate login: application reference number + PIN
        if(onCandidateLogin){
          setError("Verifying...");
          Promise.resolve(onCandidateLogin(username.trim(), password.trim())).then(function(result){
            if(!result){setError("Invalid reference number or PIN. Check and try again.");setLoading(false);setTimeout(()=>setError(""),5000);}
          });
        }
      }
  }

  return(
    <div style={{minHeight:"100vh",position:"relative",overflow:"hidden",background:`linear-gradient(160deg,${C.sidebarBg} 0%,#230E6A 50%,#3D2496 100%)`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20}}>
      {/* Auto-scrolling photo slideshow background — changes every 4 seconds */}
      {slidePhotos.length>0&&(
        <div style={{position:"absolute",inset:0,zIndex:0}}>
          {slidePhotos.map((photo,i)=>(
            <img key={photo.id} src={photo.dataUrl} alt=""
              style={{
                position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",
                opacity:i===slideIndex?0.35:0,
                transition:"opacity 1.2s ease-in-out"
              }}/>
          ))}
          <div style={{position:"absolute",inset:0,background:`linear-gradient(160deg,${C.sidebarBg}CC 0%,#230E6ACC 50%,#3D2496CC 100%)`}}/>
        </div>
      )}

      {/* Top decorative band */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:6,background:`linear-gradient(90deg,${C.gold},${C.goldLight},${C.gold})`,zIndex:2}}/>

      {/* School identity block */}
      <div style={{textAlign:"center",marginBottom:36,position:"relative",zIndex:2}}>
        <div style={{width:110,height:110,borderRadius:"50%",background:"rgba(255,255,255,0.08)",border:`3px solid ${C.gold}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",overflow:"hidden",padding:6}}>
          {settings.schoolLogo
            ? <img src={settings.schoolLogo} alt="School Logo" style={{width:"100%",height:"100%",objectFit:"contain"}}/>
            : <span style={{fontSize:32,fontWeight:900,color:"#230E6A"}}>AS</span>}
        </div>
        <div style={{fontSize:20,fontWeight:900,color:C.goldLight,letterSpacing:"0.04em",textTransform:"uppercase",textShadow:"0 2px 8px rgba(0,0,0,0.4)"}}>{SCHOOL_NAME}</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.6)",marginTop:5,letterSpacing:"0.02em"}}>{SCHOOL_ADDRESS}</div>
        <div style={{display:"inline-block",marginTop:8,background:"rgba(183,134,44,0.2)",border:`1px solid ${C.gold}`,borderRadius:20,padding:"4px 16px"}}>
          <span style={{color:C.goldLight,fontSize:11,fontWeight:600,fontStyle:"italic"}}>{SCHOOL_MOTTO}</span>
        </div>
      </div>

      {/* Login card */}
      <div style={{background:"rgba(255,255,255,0.97)",borderRadius:16,padding:"32px 36px",width:"100%",maxWidth:380,boxShadow:"0 24px 80px rgba(0,0,0,0.5)",border:`1px solid rgba(183,134,44,0.3)`,position:"relative",zIndex:2}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:14,fontWeight:800,color:C.primaryDark}}>{loginType==="staff"?"Staff & Admin Login":loginType==="parent"?"Parent Login":"Admission Applicant"}</div>
          <div style={{fontSize:11,color:C.textMuted,marginTop:3}}>School Information System v3.0</div>
          <div style={{height:2,background:`linear-gradient(90deg,transparent,${C.gold},transparent)`,marginTop:12}}/>
          {/* Login type toggle */}
          <div style={{display:"flex",gap:0,marginTop:14,border:"1px solid "+C.border,borderRadius:8,overflow:"hidden"}}>
            <button onClick={()=>{setLoginType("staff");setError("");}} style={{flex:1,padding:"8px",background:loginType==="staff"?"#230E6A":"#fff",color:loginType==="staff"?"#fff":"#6B7280",border:"none",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>👨‍💼 Staff</button>
            <button onClick={()=>{setLoginType("parent");setError("");}} style={{flex:1,padding:"8px",background:loginType==="parent"?"#230E6A":"#fff",color:loginType==="parent"?"#fff":"#6B7280",border:"none",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>👨‍👩‍👧 Parent</button>
            <button onClick={()=>{setLoginType("candidate");setCandidateMode("choose");setError("");}} style={{flex:1,padding:"8px",background:loginType==="candidate"?"#230E6A":"#fff",color:loginType==="candidate"?"#fff":"#6B7280",border:"none",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>🎓 Apply</button>
          </div>
        </div>

        {loginType==="candidate"?(
          candidateMode==="choose"?(
            <div>
              <div style={{fontSize:12,color:C.textMuted,textAlign:"center",marginBottom:16}}>Applying for admission into {SCHOOL_NAME}? Start here.</div>
              <button style={{...S.btn(),width:"100%",padding:"12px",fontSize:13,marginBottom:10}} onClick={function(){onStartApplication&&onStartApplication();}}>📝 Start New Application</button>
              <button style={{...S.btn("secondary"),width:"100%",padding:"12px",fontSize:13}} onClick={function(){setCandidateMode("login");setUsername("");setPassword("");}}>🔍 I Already Applied — Check Status</button>
            </div>
          ):(
            <div>
              <div style={S.formGroup}>
                <label style={S.label}>Application Reference No.</label>
                <input style={{...S.input,padding:"10px 12px"}} value={username} onChange={e=>setUsername(e.target.value)} placeholder="e.g. ADM/2026/1001" autoFocus/>
              </div>
              <div style={S.formGroup}>
                <label style={S.label}>PIN</label>
                <input style={{...S.input,padding:"10px 12px"}} type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="6-digit PIN" onKeyDown={e=>e.key==="Enter"&&login()}/>
              </div>
              {error&&<div style={{background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:6,padding:"8px 12px",color:C.danger,fontSize:12,marginBottom:12,textAlign:"center"}}>{error}</div>}
              <button style={{...S.btn(),width:"100%",padding:"11px",fontSize:13,borderRadius:8,opacity:loading?0.7:1}} onClick={login} disabled={loading}>{loading?"Verifying...":"Check Application →"}</button>
              <button style={{...S.btn("ghost"),width:"100%",padding:"6px",fontSize:11,marginTop:8}} onClick={function(){setCandidateMode("choose");setError("");}}>← Back</button>
            </div>
          )
        ):(
          <div>
            <div style={S.formGroup}>
              <label style={S.label}>{loginType==="staff"?"Username":"Child's Admission Number"}</label>
              <input style={{...S.input,padding:"10px 12px"}} value={username} onChange={e=>setUsername(e.target.value)} placeholder={loginType==="staff"?"Enter your username":"e.g. ASS/2022/0001"} autoFocus/>
            </div>
            {loginType==="parent"&&<div style={{background:"#EFF6FF",borderRadius:8,padding:"8px 12px",fontSize:11,color:"#1E40AF",marginBottom:4}}>
              💡 <b>Admission Number</b> + <b>Parent Phone Number</b> (as registered by school admin)
            </div>}
            <div style={S.formGroup}>
              <label style={S.label}>{loginType==="staff"?"Password":"Your Phone Number (as registered)"}</label>
              <input style={{...S.input,padding:"10px 12px"}} type={loginType==="staff"?"password":"tel"} value={password} onChange={e=>setPassword(e.target.value)} placeholder={loginType==="staff"?"Enter your password":"e.g. 08012345678"} onKeyDown={e=>e.key==="Enter"&&login()}/>
            </div>

            {error&&<div style={{background:C.dangerLight,border:`1px solid ${C.danger}`,borderRadius:6,padding:"8px 12px",color:C.danger,fontSize:12,marginBottom:12,textAlign:"center"}}>{error}</div>}

            <button style={{...S.btn(),width:"100%",padding:"11px",fontSize:13,borderRadius:8,marginTop:4,opacity:loading?0.7:1}} onClick={login} disabled={loading}>
              {loading?"Verifying...":"Login →"}
            </button>
          </div>
        )}

      </div>

      {/* Slideshow caption + dots indicator */}
      {slidePhotos.length>0&&(
        <div style={{position:"relative",zIndex:2,marginTop:18,textAlign:"center"}}>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",fontStyle:"italic"}}>{slidePhotos[slideIndex]?.eventName}</div>
          <div style={{...S.row,justifyContent:"center",marginTop:8,gap:5}}>
            {slidePhotos.slice(0,12).map((_,i)=>(
              <div key={i} style={{width:i===slideIndex?16:6,height:6,borderRadius:3,background:i===slideIndex?C.gold:"rgba(255,255,255,0.3)",transition:"all 0.3s"}}/>
            ))}
          </div>
        </div>
      )}

      {/* Bottom band */}
      <div style={{position:"absolute",bottom:0,left:0,right:0,height:4,background:`linear-gradient(90deg,${C.gold},${C.goldLight},${C.gold})`,zIndex:2}}/>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// MAIN APP

// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// ID CARDS — Front & Back redesign
// Student: Name, ID No, Class, Year of Issuance, Expiry Session
// Staff: Name, ID No, Role, Year of Issuance (no expiry)
// Back: Return message with school name & address
// Auto-calculate expiry: JSS1-JSS3 = 3yr card, SS1-SS3 = 3yr card
// ══════════════════════════════════════════════════════


// ── Shared document header for ALL printouts ──────────────────────────
function buildDocHeader(settings, title){
  var logo = settings&&settings.schoolLogo ? '<img src="'+settings.schoolLogo+'" style="width:70px;height:70px;object-fit:contain;" alt=""/>' : '<div style="width:70px;height:70px;border:2px solid #8B0000;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;color:#8B0000;font-size:18px;">AS</div>';
  var stamp = settings&&settings.schoolStamp ? '<img src="'+settings.schoolStamp+'" style="height:55px;object-fit:contain;opacity:0.85;" alt=""/>' : '';
  var sig = settings&&settings.signature ? '<img src="'+settings.signature+'" style="height:45px;object-fit:contain;" alt=""/>' : '';
  return {
    headerHtml: '<div style="display:flex;align-items:center;gap:12px;border-bottom:3px solid #8B0000;padding-bottom:10px;margin-bottom:10px;">'+logo+'<div style="flex:1;text-align:center;"><div style="font-size:20px;font-weight:900;color:#8B0000;letter-spacing:1px;">'+SCHOOL_NAME+'</div><div style="font-size:11px;color:#444;margin:2px 0;">Learning, Moral And Religion</div><div style="font-size:10px;color:#555;">'+SCHOOL_ADDRESS+' | Tel: 08039650771 | Email: safwatuadnan83@gmail.com</div></div>'+logo+'</div><div style="text-align:center;font-size:14px;font-weight:800;color:#8B0000;text-decoration:underline;margin:8px 0;">'+title+'</div>',
    footerHtml: stamp||sig ? '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:20px;padding-top:12px;border-top:1px solid #ccc;">'+(sig?'<div style="text-align:center;">'+sig+'<div style="border-top:1px solid #000;margin-top:4px;padding-top:2px;font-size:9px;">Principal&#39;s Signature</div></div>':'')+(stamp?'<div style="text-align:center;">'+stamp+'<div style="font-size:9px;margin-top:2px;">School Stamp</div></div>':'')+'</div>' : '',
    printStyles: '*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;font-size:11px;padding:15px;}table{width:100%;border-collapse:collapse;}th{background:#8B0000;color:#fff;padding:6px;font-size:10px;text-align:left;}td{padding:5px 6px;border:1px solid #ddd;font-size:10px;}@media print{body{padding:5mm;}-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
  };
}

function getExpirySession(person){
  // JSS1→expires after JSS3, SS1→expires after SS3
  var cls = person.class||"";
  var entrySess = person.entrySession||CURRENT_SESSION;
  var entryYear = parseInt(entrySess.split("/")[0])||2024;
  var expiryYear;
  if(cls.startsWith("JSS")){ expiryYear = entryYear + 3; }
  else if(cls.startsWith("SS")){ expiryYear = entryYear + 3; }
  else { expiryYear = entryYear + 1; } // Primary
  return expiryYear+"/"+(expiryYear+1);
}

function getIssueYear(person){
  var sess = person.entrySession||CURRENT_SESSION;
  return sess.split("/")[0]||new Date().getFullYear();
}

function IDCardFront({person, type, settings}){
  var isStudent = type==="student";
  var fullName = (person.surname+" "+person.firstname+" "+(person.middlename||"")).trim();
  var idNumber = isStudent ? (person.admissionNo||"ASS/----/----") : ("STAFF/"+String(person.id).slice(-4).toUpperCase());
  var accentColor = isStudent ? "#230E6A" : "#6B491B";
  var accentLight = isStudent ? "#3D2496" : "#8A5F26";
  var bodyBg = isStudent ? "#F5F3FB" : "#FBF6EE";
  var issueYear = getIssueYear(person);
  var expiry = isStudent ? getExpirySession(person) : null;
  var role = isStudent ? (person.class+(person.arm||"")) : (person.role||"Staff");

  return(
    <div style={{
      width:325, minHeight:205, borderRadius:12, overflow:"hidden", position:"relative",
      background:bodyBg, boxShadow:"0 6px 20px rgba(0,0,0,0.2)",
      fontFamily:"'Segoe UI',sans-serif", flexShrink:0,
      border:"2px solid "+accentColor
    }}>
      {/* Watermark */}
      <SchoolLogoImg size={140} style={{position:"absolute",right:-20,bottom:-20,opacity:0.06,pointerEvents:"none"}} bg="transparent"/>

      {/* Header band */}
      <div style={{background:"linear-gradient(100deg,"+accentColor+" 0%,"+accentLight+" 100%)",padding:"8px 10px",display:"flex",alignItems:"center",gap:8}}>
        <SchoolLogoImg size={30} round={true} bg="rgba(255,255,255,0.95)"/>
        <div style={{flex:1}}>
          <div style={{fontSize:9.5,fontWeight:800,color:"#fff",letterSpacing:"0.02em"}}>{SCHOOL_NAME}</div>
          <div style={{fontSize:6,color:"rgba(255,255,255,0.8)",marginTop:1}}>{SCHOOL_ADDRESS}</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.15)",borderRadius:4,padding:"2px 6px",fontSize:7,color:"#F0C060",fontWeight:700,border:"1px solid rgba(240,192,96,0.4)"}}>
          {isStudent?"STUDENT":"STAFF"}
        </div>
      </div>

      {/* Gold divider */}
      <div style={{height:2,background:"linear-gradient(90deg,#6B491B,#D4AF6A,#6B491B)"}}/>

      {/* Body */}
      <div style={{padding:"8px 10px",display:"flex",gap:8,alignItems:"flex-start"}}>
        {/* Photo */}
        <div style={{width:62,height:72,borderRadius:6,overflow:"hidden",flexShrink:0,border:"2px solid "+accentColor,background:"#E5E7EB",display:"flex",alignItems:"center",justifyContent:"center"}}>
          {person.passport
            ? <img src={person.passport} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            : <span style={{fontSize:26,color:"#9CA3AF"}}>{isStudent?"👤":"👩‍💼"}</span>
          }
        </div>

        {/* Info */}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,fontWeight:900,color:accentColor,lineHeight:1.2,marginBottom:4,wordBreak:"break-word"}}>{fullName}</div>

          {[
            ["ID No.", idNumber],
            [isStudent?"Class":null, isStudent?role:null],
            [isStudent?null:"Role", isStudent?null:role],
            ["Issued", issueYear],
            isStudent ? ["Expires", expiry] : null,
          ].filter(Boolean).map(function(pair,i){
            if(!pair[0]) return null;
            return(
              <div key={i} style={{display:"flex",gap:4,marginBottom:2}}>
                <span style={{fontSize:8,color:"#6B7280",minWidth:42,fontWeight:600}}>{pair[0]}:</span>
                <span style={{fontSize:8.5,fontWeight:700,color:"#1F2937"}}>{pair[1]}</span>
              </div>
            );
          })}

          {/* Blood group & genotype for students */}
          {isStudent && (person.bloodGroup||person.genotype) ? (
            <div style={{display:"flex",gap:6,marginTop:3}}>
              {person.bloodGroup ? <span style={{fontSize:7.5,background:accentColor,color:"#fff",padding:"1px 5px",borderRadius:3,fontWeight:700}}>🩸 {person.bloodGroup}</span> : null}
              {person.genotype ? <span style={{fontSize:7.5,background:"#F0C060",color:"#1F2937",padding:"1px 5px",borderRadius:3,fontWeight:700}}>{person.genotype}</span> : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Footer bar */}
      <div style={{background:accentColor,padding:"3px 10px",display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:2}}>
        <span style={{fontSize:7,color:"rgba(255,255,255,0.7)"}}>Learning · Moral · Religion</span>
        <span style={{fontSize:7,color:"#F0C060",fontWeight:700}}>{isStudent?"VALID: "+issueYear+" – "+expiry:"NO EXPIRY"}</span>
      </div>
    </div>
  );
}

function IDCardBack({person, type, settings}){
  var isStudent = type==="student";
  var accentColor = isStudent ? "#230E6A" : "#6B491B";
  var accentLight = isStudent ? "#3D2496" : "#8A5F26";
  var bodyBg = isStudent ? "#F5F3FB" : "#FBF6EE";

  return(
    <div style={{
      width:325, minHeight:205, borderRadius:12, overflow:"hidden", position:"relative",
      background:bodyBg, boxShadow:"0 6px 20px rgba(0,0,0,0.2)",
      fontFamily:"'Segoe UI',sans-serif", flexShrink:0,
      border:"2px solid "+accentColor
    }}>
      {/* Header band — same as front */}
      <div style={{background:"linear-gradient(100deg,"+accentColor+" 0%,"+accentLight+" 100%)",padding:"8px 10px",display:"flex",alignItems:"center",gap:8}}>
        <SchoolLogoImg size={30} round={true} bg="rgba(255,255,255,0.95)"/>
        <div style={{flex:1}}>
          <div style={{fontSize:9.5,fontWeight:800,color:"#fff"}}>{SCHOOL_NAME}</div>
          <div style={{fontSize:6,color:"rgba(255,255,255,0.7)"}}>{SCHOOL_ADDRESS}</div>
        </div>
      </div>
      <div style={{height:2,background:"linear-gradient(90deg,#6B491B,#D4AF6A,#6B491B)"}}/>

      {/* Return message */}
      <div style={{padding:"12px 14px",textAlign:"center"}}>
        <div style={{fontSize:10,fontWeight:800,color:accentColor,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>
          — IMPORTANT NOTICE —
        </div>
        <div style={{fontSize:11,lineHeight:1.7,color:"#1F2937",fontStyle:"italic",marginBottom:10,padding:"0 6px"}}>
          The person whose photograph appears on the other side of this card is a{isStudent?" student":" staff member"} of this school.
        </div>
        <div style={{fontSize:11,lineHeight:1.7,color:"#374151",fontWeight:600,marginBottom:10}}>
          If found, please return to:
        </div>
        <div style={{background:accentColor,borderRadius:8,padding:"8px 12px",color:"#fff"}}>
          <div style={{fontSize:11,fontWeight:900,marginBottom:2}}>{SCHOOL_NAME}</div>
          <div style={{fontSize:9,opacity:0.9,lineHeight:1.5}}>{SCHOOL_ADDRESS}</div>
          <div style={{fontSize:9,opacity:0.9,marginTop:2}}>Tel: 08039650771</div>
        </div>
      </div>

      {/* Signature area */}
      <div style={{padding:"0 14px 8px",display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
        <div style={{textAlign:"center"}}>
          {settings&&settings.signature
            ? <img src={settings.signature} style={{height:32,objectFit:"contain"}}/>
            : <div style={{height:32,width:80,borderBottom:"1px solid "+accentColor}}/>
          }
          <div style={{fontSize:7.5,color:"#6B7280",marginTop:2}}>Principal's Signature</div>
        </div>
        {settings&&settings.schoolStamp
          ? <img src={settings.schoolStamp} style={{height:40,objectFit:"contain",opacity:0.85}}/>
          : <div style={{height:40,width:40,border:"1px dashed #ccc",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,color:"#ccc"}}>STAMP</div>
        }
      </div>
    </div>
  );
}

function IDCardsModule({students, staff, settings, currentUser}){
  var _type = useState("student"); var cardType = _type[0]; var setCardType = _type[1];
  var _search = useState(""); var search = _search[0]; var setSearch = _search[1];
  var _selClass = useState(""); var selClass = _selClass[0]; var setSelClass = _selClass[1];
  var _selRole = useState(""); var selRole = _selRole[0]; var setSelRole = _selRole[1];
  var _showBack = useState(false); var showBack = _showBack[0]; var setShowBack = _showBack[1];
  var _selPerson = useState(null); var selPerson = _selPerson[0]; var setSelPerson = _selPerson[1];

  var isAdmin = currentUser.role==="root"||currentUser.role==="admin";
  var roles = [...new Set(staff.map(function(s){return s.role||"Teacher";}))].sort();

  var filteredStudents = students.filter(function(s){
    var matchSearch = !search || (s.surname+" "+s.firstname).toLowerCase().includes(search.toLowerCase()) || (s.admissionNo||"").toLowerCase().includes(search.toLowerCase());
    var matchClass = !selClass || s.class===selClass;
    return s.active && matchSearch && matchClass;
  });

  var filteredStaff = staff.filter(function(s){
    var matchSearch = !search || (s.surname+" "+s.firstname).toLowerCase().includes(search.toLowerCase());
    var matchRole = !selRole || (s.role||"Teacher")===selRole;
    return matchSearch && matchRole;
  });

  var people = cardType==="student" ? filteredStudents : filteredStaff;

  function buildCardHtml(person){
    var isStudent = cardType==="student";
    var ac = isStudent?"#230E6A":"#6B491B";
    var al = isStudent?"#3D2496":"#8A5F26";
    var bg = isStudent?"#F5F3FB":"#FBF6EE";
    var logo = settings&&settings.schoolLogo ? `<img src="${settings.schoolLogo}" style="width:28px;height:28px;object-fit:contain;border-radius:50%;background:#fff;" alt=""/>` : `<div style="width:28px;height:28px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;color:${ac};font-size:10px;">AS</div>`;
    var photo = person.passport ? `<img src="${person.passport}" style="width:100%;height:100%;object-fit:cover;"/>` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;">${isStudent?"👤":"👩‍💼"}</div>`;
    var fullName = (person.surname+" "+person.firstname+" "+(person.middlename||"")).trim();
    var idNum = isStudent ? (person.admissionNo||"---") : ("STAFF/"+String(person.id).slice(-4).toUpperCase());
    var issueYear = getIssueYear(person);
    var expiry = isStudent ? getExpirySession(person) : null;
    var role = isStudent ? (person.class+(person.arm||"")) : (person.role||"Staff");
    var stamp = settings&&settings.schoolStamp ? `<img src="${settings.schoolStamp}" style="height:38px;object-fit:contain;opacity:0.85;"/>` : `<div style="height:38px;width:38px;border:1px dashed #ccc;border-radius:50%;"></div>`;
    var sig = settings&&settings.signature ? `<img src="${settings.signature}" style="height:30px;object-fit:contain;"/>` : `<div style="height:30px;width:80px;border-bottom:1px solid ${ac};"></div>`;

    var html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>ID Card - ${fullName}</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f0f0;display:flex;justify-content:center;align-items:flex-start;padding:20px;gap:20px;flex-wrap:wrap;}
.card{width:325px;min-height:205px;border-radius:12px;overflow:hidden;background:${bg};box-shadow:0 6px 20px rgba(0,0,0,0.2);border:2px solid ${ac};position:relative;page-break-inside:avoid;}
.header{background:linear-gradient(100deg,${ac} 0%,${al} 100%);padding:8px 10px;display:flex;align-items:center;gap:8px;}
.divider{height:2px;background:linear-gradient(90deg,#6B491B,#D4AF6A,#6B491B);}
.body{padding:8px 10px;display:flex;gap:8px;}
.photo{width:62px;height:72px;border-radius:6px;overflow:hidden;border:2px solid ${ac};background:#E5E7EB;flex-shrink:0;}
.footer{background:${ac};padding:3px 10px;display:flex;justify-content:space-between;align-items:center;}
.back-msg{padding:10px 14px;text-align:center;}
.return-box{background:${ac};border-radius:8px;padding:8px 12px;color:#fff;}
.sig-row{padding:0 14px 8px;display:flex;justify-content:space-between;align-items:flex-end;}
@media print{body{background:#fff;padding:5mm;}}</style></head>
<body>
<div class="card">
  <div class="header">
    ${logo}
    <div style="flex:1"><div style="font-size:9.5px;font-weight:800;color:#fff;">${SCHOOL_NAME}</div><div style="font-size:6px;color:rgba(255,255,255,0.75);">${SCHOOL_ADDRESS}</div></div>
    <div style="background:rgba(255,255,255,0.15);border-radius:4px;padding:2px 6px;font-size:7px;color:#F0C060;font-weight:700;border:1px solid rgba(240,192,96,0.4);">${isStudent?"STUDENT":"STAFF"}</div>
  </div>
  <div class="divider"></div>
  <div class="body">
    <div class="photo">${photo}</div>
    <div style="flex:1">
      <div style="font-size:12px;font-weight:900;color:${ac};line-height:1.2;margin-bottom:4px;">${fullName}</div>
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-size:8px;color:#6B7280;min-width:42px;font-weight:600;">ID No.:</span><span style="font-size:8.5px;font-weight:700;">${idNum}</span></div>
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-size:8px;color:#6B7280;min-width:42px;font-weight:600;">${isStudent?"Class":"Role"}:</span><span style="font-size:8.5px;font-weight:700;">${role}</span></div>
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-size:8px;color:#6B7280;min-width:42px;font-weight:600;">Issued:</span><span style="font-size:8.5px;font-weight:700;">${issueYear}</span></div>
      ${isStudent?`<div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-size:8px;color:#6B7280;min-width:42px;font-weight:600;">Expires:</span><span style="font-size:8.5px;font-weight:700;">${expiry}</span></div>`:""}
      ${isStudent&&(person.bloodGroup||person.genotype)?`<div style="display:flex;gap:6px;margin-top:3px;">${person.bloodGroup?`<span style="font-size:7.5px;background:${ac};color:#fff;padding:1px 5px;border-radius:3px;font-weight:700;">🩸 ${person.bloodGroup}</span>`:""} ${person.genotype?`<span style="font-size:7.5px;background:#F0C060;color:#1F2937;padding:1px 5px;border-radius:3px;font-weight:700;">${person.genotype}</span>`:""}</div>`:""}
    </div>
  </div>
  <div class="footer">
    <span style="font-size:7px;color:rgba(255,255,255,0.7);">Learning · Moral · Religion</span>
    <span style="font-size:7px;color:#F0C060;font-weight:700;">${isStudent?"VALID: "+issueYear+" – "+expiry:"NO EXPIRY"}</span>
  </div>
</div>

<div class="card">
  <div class="header">
    ${logo}
    <div style="flex:1"><div style="font-size:9.5px;font-weight:800;color:#fff;">${SCHOOL_NAME}</div><div style="font-size:6px;color:rgba(255,255,255,0.7);">${SCHOOL_ADDRESS}</div></div>
  </div>
  <div class="divider"></div>
  <div class="back-msg">
    <div style="font-size:10px;font-weight:800;color:${ac};margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">— IMPORTANT NOTICE —</div>
    <div style="font-size:11px;line-height:1.7;color:#1F2937;font-style:italic;margin-bottom:8px;">The person whose photograph appears on the other side of this card is a ${isStudent?"student":"staff member"} of this school.</div>
    <div style="font-size:11px;line-height:1.7;color:#374151;font-weight:600;margin-bottom:8px;">If found, please return to:</div>
    <div class="return-box">
      <div style="font-size:11px;font-weight:900;margin-bottom:2px;">${SCHOOL_NAME}</div>
      <div style="font-size:9px;opacity:0.9;line-height:1.5;">${SCHOOL_ADDRESS}</div>
      <div style="font-size:9px;opacity:0.9;margin-top:2px;">Tel: 08039650771</div>
    </div>
  </div>
  <div class="sig-row">
    <div style="text-align:center;">${sig}<div style="font-size:7.5px;color:#6B7280;margin-top:2px;">Principal's Signature</div></div>
    ${stamp}
  </div>
</div>
</body></html>`;
    return html;
  }

  function printCard(person){ printHtmlDoc(buildCardHtml(person)); }
  async function downloadCardPDF(person){
    try{ await downloadHtmlDocAsPDF(buildCardHtml(person), (person.surname||"card")+"_"+(person.firstname||"")+"_IDCard"); }
    catch(e){ alert("Could not generate PDF: "+e.message); }
  }
  async function shareCard(person){
    try{ await shareHtmlDoc(buildCardHtml(person), (person.surname||"card")+"_"+(person.firstname||"")+"_IDCard", "ID Card — "+person.surname+" "+person.firstname); }
    catch(e){ alert("Could not share: "+e.message); }
  }

  function bulkPrintAll(){
    var cards = people.slice(0,50).map(function(p){ return p; });
    // Print first card then alert for bulk
    alert("Bulk printing "+cards.length+" cards. Each card will open with front and back. Your browser may block popups — please allow them.");
    cards.forEach(function(p,i){
      setTimeout(function(){ printCard(p); }, i*1000);
    });
  }

  return(
    <div>
      {/* Controls */}
      <div style={{...S.card,marginBottom:14}}>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",background:"#F3F4F6",borderRadius:8,overflow:"hidden",border:"1px solid "+C.border}}>
              <button onClick={function(){setCardType("student");setSearch("");}} style={{background:cardType==="student"?"#230E6A":"transparent",color:cardType==="student"?"#fff":"#374151",border:"none",padding:"6px 16px",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>👨‍🎓 Students</button>
              <button onClick={function(){setCardType("staff");setSearch("");}} style={{background:cardType==="staff"?"#6B491B":"transparent",color:cardType==="staff"?"#fff":"#374151",border:"none",padding:"6px 16px",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>👩‍💼 Staff</button>
            </div>
            <input style={{...S.input,minWidth:180}} placeholder={"Search "+(cardType==="student"?"students":"staff")+"..."} value={search} onChange={function(e){setSearch(e.target.value);}}/>
            {cardType==="student" ? (
              <select style={S.select} value={selClass} onChange={function(e){setSelClass(e.target.value);}}>
                <option value="">All Classes</option>
                {CLASSES.map(function(c){return <option key={c}>{c}</option>;})}
              </select>
            ) : (
              <select style={S.select} value={selRole} onChange={function(e){setSelRole(e.target.value);}}>
                <option value="">All Roles</option>
                {roles.map(function(r){return <option key={r}>{r}</option>;})}
              </select>
            )}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer"}}>
              <input type="checkbox" checked={showBack} onChange={function(){setShowBack(function(p){return !p;});}}/>
              Show back side
            </label>
            <button onClick={bulkPrintAll} style={S.btn()}>🖨 Bulk Print</button>
          </div>
        </div>
        <div style={{fontSize:11,color:C.textMuted,marginTop:8}}>{people.length} {cardType==="student"?"student":"staff"} card{people.length!==1?"s":""} found</div>
      </div>

      {/* Cards grid */}
      {people.length===0 ? (
        <div style={{...S.card,textAlign:"center",color:C.textMuted,padding:40}}>
          <div style={{fontSize:36,marginBottom:8}}>🪪</div>
          <div style={{fontSize:13,fontWeight:600}}>No {cardType==="student"?"students":"staff"} found</div>
        </div>
      ) : (
        <div style={{display:"flex",flexWrap:"wrap",gap:20}}>
          {people.map(function(person){
            var isSelected = selPerson&&selPerson.id===person.id;
            return(
              <div key={person.id} style={{display:"flex",flexDirection:"column",gap:8,cursor:"pointer"}} onClick={function(){setSelPerson(isSelected?null:person);}}>
                <IDCardFront person={person} type={cardType} settings={settings}/>
                {showBack ? <IDCardBack person={person} type={cardType} settings={settings}/> : null}
                <div style={{display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap"}}>
                  <button onClick={function(e){e.stopPropagation();printCard(person);}} style={{...S.btn(),fontSize:11,padding:"4px 12px"}}>🖨 Print</button>
                  <button onClick={function(e){e.stopPropagation();downloadCardPDF(person);}} style={{...S.btn("blue"),fontSize:11,padding:"4px 12px"}}>⬇ PDF</button>
                  <button onClick={function(e){e.stopPropagation();shareCard(person);}} style={{...S.btn("gold"),fontSize:11,padding:"4px 12px"}}>📤 Share</button>
                  <span style={{fontSize:10,color:C.textMuted,alignSelf:"center"}}>{(person.surname+" "+person.firstname).slice(0,18)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


export default function App(){
  const [currentUser,setCurrentUser]=useState(null);
  const [page,setPage]=useState("dashboard");
  const [dbStatus,setDbStatus]=useState("loading");
  const [parentStudent,setParentStudent]=useState(null); // set when parent logs in
  const [parentToken,setParentToken]=useState(null); // scoped JWT, needed for CBT exam actions
  const [parentData,setParentData]=useState({results:[],attendance:[],fees:[],diary:[],elibrary:[],lessons:[],assignments:[],submissions:[],exams:[],gallery:[]});
  const [candidateToken,setCandidateToken]=useState(null);
  const [candidateApp,setCandidateApp]=useState(null);
  const [showNewApplication,setShowNewApplication]=useState(false);
  const [candidateJustIssued,setCandidateJustIssued]=useState(null); // {refNo,pin} shown once right after submitting
  const [candidateSubmitting,setCandidateSubmitting]=useState(false);
  const isMobile = useIsMobile();
  const [sidebarOpen,setSidebarOpen]=useState(false);

  // ── Raw state (Supabase feeds into these) ──────────
  const [students,_setStudents]=useState(SEED_STUDENTS);
  const [results,_setResults]=useState(SEED_RESULTS);
  const [fees,_setFees]=useState(SEED_FEES);
  const [expenditure,_setExpenditure]=useState(SEED_EXPENDITURE);
  const [attendance,_setAttendance]=useState(SEED_ATTENDANCE);
  const [conduct,_setConduct]=useState(SEED_CONDUCT);
  const [promotions,_setPromotions]=useState(SEED_PROMOTIONS);
  const [staff,_setStaff]=useState(SEED_STAFF);
  const [timetable,_setTimetable]=useState(SEED_TIMETABLE);
  const [messages,_setMessages]=useState(SEED_MESSAGES);
  const [settings,_setSettings]=useState(SEED_SETTINGS);
  const [lessons,_setLessons]=useState(SEED_LESSONS);
  const [assignments,_setAssignments]=useState(SEED_ASSIGNMENTS);
  const [submissions,_setSubmissions]=useState(SEED_SUBMISSIONS);
  const [diary,_setDiary]=useState(SEED_DIARY);
  const [gallery,_setGallery]=useState(SEED_GALLERY);
  const [elibrary,_setElibrary]=useState(SEED_ELIBRARY);
  const [clinic,_setClinic]=useState(SEED_CLINIC);
  const [counsellingSessions,_setCounsellingSessions]=useState([]);
  const [classRemarks,_setClassRemarks]=useState([]);
  const [hostelInventory,_setHostelInventory]=useState([]);
  const [hostelConsumption,_setHostelConsumption]=useState([]);
  const [hostelRequests,_setHostelRequests]=useState([]);
  const [hostelRooms,_setHostelRooms]=useState([]);
  const [hostelRollcall,_setHostelRollcall]=useState([]);
  const [hostelIncidents,_setHostelIncidents]=useState([]);
  const [applications,_setApplications]=useState([]);
  const [exams,_setExams]=useState(SEED_EXAMS);
  const [examMarks,_setExamMarks]=useState({});
  const [cbtEnabled,setCbtEnabled]=useState(false);

  // ── Synced setters — every change auto-saves to Supabase ──
  const setStudents   = makeSynced("students",   _setStudents,   false);
  const setResults    = makeSynced("results",    _setResults,    false);
  const setFees       = makeSynced("fees",       _setFees,       false);
  const setExpenditure= makeSynced("expenditure",_setExpenditure,false);
  const setAttendance = makeSynced("attendance", _setAttendance, false);
  const setConduct    = makeSynced("conduct",    _setConduct,    false);
  const setPromotions = makeSynced("promotions", _setPromotions, false);
  const setStaff      = makeSynced("staff",      _setStaff,      false);
  const setTimetable  = makeSynced("timetable",  _setTimetable,  false);
  const setMessages   = makeSynced("messages",   _setMessages,   false);
  const setSettings = makeSynced("settings", _setSettings, true);
  // Wrap setSettings to also backup critical data to localStorage

  const setLessons    = makeSynced("lessons",    _setLessons,    false);
  const setAssignments= makeSynced("assignments",_setAssignments,false);
  const setSubmissions= makeSynced("submissions",_setSubmissions,false);
  const setDiary      = makeSynced("diary",      _setDiary,      false);
  const setGallery    = makeSynced("gallery",    _setGallery,    false);
  const setElibrary   = makeSynced("elibrary",   _setElibrary,   false);
  const setClinic     = makeSynced("clinic",     _setClinic,     false);
  const setCounsellingSessions = makeSynced("counselling", _setCounsellingSessions, false);
  const setClassRemarks = makeSynced("class_remarks", _setClassRemarks, false);
  const setHostelInventory = makeSynced("hostel_inventory", _setHostelInventory, false);
  const setHostelConsumption = makeSynced("hostel_consumption", _setHostelConsumption, false);
  const setHostelRequests = makeSynced("hostel_requests", _setHostelRequests, false);
  const setHostelRooms = makeSynced("hostel_rooms", _setHostelRooms, false);
  const setHostelRollcall = makeSynced("hostel_rollcall", _setHostelRollcall, false);
  const setHostelIncidents = makeSynced("hostel_incidents", _setHostelIncidents, false);
  const setApplications = makeSynced("admissions", _setApplications, false);
  const setExams       = makeSynced("exams",      _setExams,      false);
  const setExamMarks   = makeSynced("exam_marks", _setExamMarks,  true);

  // ── Startup, Stage A: public branding data — loads unauthenticated,
  // before login, so the login screen can render logo/slideshow. Admin
  // accounts are NOT loaded here (see SettingsModule, which fetches them
  // from the authenticated /api/admin endpoint once logged in).
  useEffect(function(){
    async function loadPublicData(){
      setDbStatus("loading");
      try {
        const [dbSettings, dbGallery, dbSchoolAssets] = await Promise.all([
          sbLoad("settings"), sbLoad("gallery"), sbLoad("school_assets")
        ]);

        if(dbGallery && dbGallery.length) _setGallery(dbGallery);
        markSynced("gallery", dbGallery);

        var restored = {...SEED_SETTINGS};
        if(dbSettings && typeof dbSettings === "object" && !Array.isArray(dbSettings)){
          Object.keys(dbSettings).forEach(function(k){
            if(dbSettings[k] !== undefined && dbSettings[k] !== null && dbSettings[k] !== "")
              restored[k] = dbSettings[k];
          });
        }

        // Restore images - prefer localStorage (fast), then school_assets (authoritative)
        ["schoolLogo","schoolStamp","signature"].forEach(function(field){
          try{ var ls=localStorage.getItem("asis_"+field); if(ls) restored[field]=ls; }catch(ex){}
        });
        if(dbSchoolAssets && dbSchoolAssets.length > 0){
          dbSchoolAssets.forEach(function(asset){
            if(asset && asset.field && asset.value){
              restored[asset.field] = asset.value;
              try{ localStorage.setItem("asis_"+asset.field, asset.value); }catch(ex){}
            }
          });
        }

        _setSettings(restored);
        setDbStatus("online");
      } catch(err){
        console.error("Public data load error:", err);
        setDbStatus("offline");
      }
    }
    loadPublicData();
  }, []);

  // ── Startup, Stage B: everything else — only loads once a token exists
  // (currentUser set after a successful /api/login), since these tables
  // require auth in db.js.
  useEffect(function(){
    if(!currentUser) return;
    async function loadProtectedData(){
      try {
        const [
          dbStudents, dbStaff, dbAttendance, dbResults, dbFees, dbExpenditure,
          dbLessons, dbAssignments, dbSubmissions, dbMessages, dbDiary,
          dbElibrary, dbConduct, dbTimetable, dbPromotions, dbClinic,
          dbCounselling, dbExams, dbExamMarks, dbClassRemarks,
          dbHostelInventory, dbHostelConsumption, dbHostelRequests, dbHostelRooms, dbHostelRollcall, dbHostelIncidents,
          dbApplications
        ] = await Promise.all([
          sbLoad("students"), sbLoad("staff"), sbLoad("attendance"), sbLoad("results"),
          sbLoad("fees"), sbLoad("expenditure"), sbLoad("lessons"), sbLoad("assignments"),
          sbLoad("submissions"), sbLoad("messages"), sbLoad("diary"),
          sbLoad("elibrary"), sbLoad("conduct"), sbLoad("timetable"), sbLoad("promotions"), sbLoad("clinic"),
          sbLoad("counselling"), sbLoad("exams"), sbLoad("exam_marks"), sbLoad("class_remarks"),
          sbLoad("hostel_inventory"), sbLoad("hostel_consumption"), sbLoad("hostel_requests"), sbLoad("hostel_rooms"), sbLoad("hostel_rollcall"), sbLoad("hostel_incidents"),
          sbLoad("admissions")
        ]);

        if(dbStudents && dbStudents.length)      _setStudents(dbStudents);
        markSynced("students", dbStudents);
        if(dbStaff && dbStaff.length)            _setStaff(dbStaff);
        markSynced("staff", dbStaff);
        if(dbAttendance && dbAttendance.length)  _setAttendance(dbAttendance);
        markSynced("attendance", dbAttendance);
        if(dbResults && dbResults.length)        _setResults(dbResults);
        markSynced("results", dbResults);
        if(dbFees && dbFees.length)              _setFees(dbFees);
        markSynced("fees", dbFees);
        if(dbExpenditure && dbExpenditure.length)_setExpenditure(dbExpenditure);
        markSynced("expenditure", dbExpenditure);
        if(dbLessons && dbLessons.length)        _setLessons(dbLessons);
        markSynced("lessons", dbLessons);
        if(dbAssignments && dbAssignments.length)_setAssignments(dbAssignments);
        markSynced("assignments", dbAssignments);
        if(dbSubmissions && dbSubmissions.length)_setSubmissions(dbSubmissions);
        markSynced("submissions", dbSubmissions);
        if(dbMessages && dbMessages.length)      _setMessages(dbMessages);
        markSynced("messages", dbMessages);
        if(dbDiary && dbDiary.length)            _setDiary(dbDiary);
        markSynced("diary", dbDiary);
        if(dbElibrary && dbElibrary.length)      _setElibrary(dbElibrary);
        markSynced("elibrary", dbElibrary);
        if(dbConduct && dbConduct.length)        _setConduct(dbConduct);
        markSynced("conduct", dbConduct);
        if(dbTimetable && dbTimetable.length)    _setTimetable(dbTimetable);
        markSynced("timetable", dbTimetable);
        if(dbPromotions && dbPromotions.length)  _setPromotions(dbPromotions);
        markSynced("promotions", dbPromotions);
        if(dbClinic && dbClinic.length)          _setClinic(dbClinic);
        markSynced("clinic", dbClinic);
        if(dbCounselling && dbCounselling.length)_setCounsellingSessions(dbCounselling);
        markSynced("counselling", dbCounselling);
        if(dbClassRemarks && dbClassRemarks.length) _setClassRemarks(dbClassRemarks);
        markSynced("class_remarks", dbClassRemarks);
        if(dbHostelInventory && dbHostelInventory.length) _setHostelInventory(dbHostelInventory);
        markSynced("hostel_inventory", dbHostelInventory);
        if(dbHostelConsumption && dbHostelConsumption.length) _setHostelConsumption(dbHostelConsumption);
        markSynced("hostel_consumption", dbHostelConsumption);
        if(dbHostelRequests && dbHostelRequests.length) _setHostelRequests(dbHostelRequests);
        markSynced("hostel_requests", dbHostelRequests);
        if(dbHostelRooms && dbHostelRooms.length) _setHostelRooms(dbHostelRooms);
        markSynced("hostel_rooms", dbHostelRooms);
        if(dbHostelRollcall && dbHostelRollcall.length) _setHostelRollcall(dbHostelRollcall);
        markSynced("hostel_rollcall", dbHostelRollcall);
        if(dbHostelIncidents && dbHostelIncidents.length) _setHostelIncidents(dbHostelIncidents);
        markSynced("hostel_incidents", dbHostelIncidents);
        if(dbApplications && dbApplications.length) _setApplications(dbApplications);
        markSynced("admissions", dbApplications);
        if(dbExams && dbExams.length)            _setExams(dbExams);
        markSynced("exams", dbExams);
        if(dbExamMarks && typeof dbExamMarks==="object") _setExamMarks(dbExamMarks);

        // Flush any queued offline writes now that we're authenticated and connected
        loadOfflineQueue();
        if(_offlineQueue.length){
          console.log("[Offline Queue] Flushing "+_offlineQueue.length+" queued operations...");
          flushOfflineQueue(function(sent,failed){
            console.log("[Offline Queue] Flushed: "+sent+" sent, "+failed+" failed");
          });
        }
      } catch(err){
        console.error("Protected data load error:", err);
      }
    }
    loadProtectedData();
  }, [currentUser]);

  // Show parent portal if parent logged in
  if(parentStudent){
    return <ParentPortal student={parentStudent} students={[]} results={parentData.results} attendance={parentData.attendance} fees={parentData.fees} settings={settings} diary={parentData.diary} elibrary={parentData.elibrary} lessons={parentData.lessons} assignments={parentData.assignments} submissions={parentData.submissions} exams={parentData.exams} gallery={parentData.gallery} parentToken={parentToken} onRefresh={()=>refreshParentData(parentToken)} onLogout={()=>{setParentStudent(null);setParentToken(null);setParentData({results:[],attendance:[],fees:[],diary:[],elibrary:[],lessons:[],assignments:[],submissions:[],exams:[],gallery:[]});}}/>;
  }

  // Show the admission candidate portal — either filling a brand new
  // application (not yet submitted) or logged into an existing one.
  if(showNewApplication && !candidateApp){
    return <CandidatePortal mode="new" candidateApp={null} justIssued={null} settings={settings} gallery={gallery} submitting={candidateSubmitting}
      onSubmitApplication={handleCandidateApply} onCancel={()=>setShowNewApplication(false)}/>;
  }
  if(candidateApp){
    return <CandidatePortal mode="portal" candidateApp={candidateApp} justIssued={candidateJustIssued} settings={settings} gallery={gallery} submitting={candidateSubmitting}
      onUpdateApplication={handleCandidateUpdate} onLogout={handleCandidateLogout}/>;
  }

  // Parent credentials (Admission No. + registered phone) are verified
  // server-side, since students isn't loaded client-side before a staff
  // login — see parent-login.js / parent-data.js. The returned "parent"
  // token is scoped to exactly one student and only ever used against
  // /api/parent-data, never /api/db (which would return every family's
  // records, not just this one).
  async function refreshParentData(token){
    const dataRes = await fetch("/api/parent-data", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},
      body:JSON.stringify({})
    }).then(r=>r.json());

    setParentData({
      results: dataRes.results||[],
      attendance: dataRes.attendance||[],
      fees: dataRes.fees||[],
      diary: dataRes.diary||[],
      elibrary: dataRes.elibrary||[],
      lessons: dataRes.lessons||[],
      assignments: dataRes.assignments||[],
      submissions: dataRes.submissions||[],
      exams: dataRes.exams||[],
      gallery: dataRes.gallery||[]
    });
  }

  async function handleParentLogin(admissionNo, phone){
    try{
      const loginRes = await fetch("/api/parent-login", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({admissionNo, phone})
      }).then(r=>r.json());

      if(!loginRes.success||!loginRes.token||!loginRes.student) return false;

      await refreshParentData(loginRes.token);
      setParentToken(loginRes.token);
      setParentStudent(loginRes.student);
      return true;
    } catch(e){
      console.error("[ParentLogin]", e.message);
      return false;
    }
  }

  function handleStartApplication(){
    setCandidateApp(null);
    setCandidateToken(null);
    setCandidateJustIssued(null);
    setShowNewApplication(true);
  }

  async function handleCandidateApply(applicationForm){
    setCandidateSubmitting(true);
    try{
      const res = await fetch("/api/candidate", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"apply", application:applicationForm})
      }).then(r=>r.json());
      setCandidateSubmitting(false);
      if(!res.success){ alert(res.error||"Could not submit application."); return; }
      setCandidateToken(res.token);
      setCandidateApp(res.application);
      setCandidateJustIssued({refNo:res.refNo, pin:res.pin});
      setShowNewApplication(false);
    } catch(e){
      setCandidateSubmitting(false);
      alert("Could not reach the server: "+e.message);
    }
  }

  async function handleCandidateLogin(refNo, pin){
    try{
      const res = await fetch("/api/candidate", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"login", refNo, pin})
      }).then(r=>r.json());
      if(!res.success||!res.token) return false;
      setCandidateToken(res.token);
      setCandidateApp(res.application);
      setCandidateJustIssued(null);
      return true;
    } catch(e){
      console.error("[CandidateLogin]", e.message);
      return false;
    }
  }

  async function handleCandidateUpdate(applicationForm){
    if(!candidateToken) return;
    setCandidateSubmitting(true);
    try{
      const res = await fetch("/api/candidate", {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+candidateToken},
        body:JSON.stringify({action:"update", application:applicationForm})
      }).then(r=>r.json());
      setCandidateSubmitting(false);
      if(!res.success){ alert(res.error||"Could not save changes."); return; }
      setCandidateApp(res.application);
      alert("Changes saved successfully.");
    } catch(e){
      setCandidateSubmitting(false);
      alert("Could not reach the server: "+e.message);
    }
  }

  function handleCandidateLogout(){
    setCandidateToken(null);
    setCandidateApp(null);
    setShowNewApplication(false);
    setCandidateJustIssued(null);
  }

  // Show login if not authenticated
  if(!currentUser){return <LoginScreen settings={settings} gallery={gallery} onLogin={(user)=>{setCurrentUser(user);setPage("dashboard");}} onParentLogin={handleParentLogin} onCandidateLogin={handleCandidateLogin} onStartApplication={handleStartApplication}/>;}

  const isRoot=currentUser.role==="root";
  const mm_dd=today().slice(5);
  const todayBdays=students.filter(s=>s.active&&s.dob&&s.dob.slice(5)===mm_dd).length+staff.filter(s=>s.active&&s.dob&&s.dob.slice(5)===mm_dd).length;

  // Only show nav items this user can access
  const visibleNav=NAV.filter(n=>userCanAccess(currentUser,n.id));
  const sections=[...new Set(visibleNav.map(n=>n.section))];

  // Guard: if user tries to access a page they can't, bounce them to dashboard
  function navigate(pid){
    if(userCanAccess(currentUser,pid)||pid==="dashboard"){setPage(pid);}
    else{alert("You do not have permission to access that page.");setPage("dashboard");}
    setSidebarOpen(false); // close the mobile drawer after picking a page
  }

  // Access-denied screen
  function AccessDenied(){
    return(<div style={{...S.card,textAlign:"center",padding:48}}>
      <div style={{fontSize:40,marginBottom:12}}>🔒</div>
      <div style={{fontSize:16,fontWeight:700,color:C.danger,marginBottom:8}}>Access Denied</div>
      <div style={{fontSize:13,color:C.textMuted,marginBottom:18}}>You do not have permission to view this page.<br/>Contact the root admin to request access.</div>
      <button style={S.btn()} onClick={()=>setPage("dashboard")}>← Back to Dashboard</button>
    </div>);
  }

  return(<LogoContext.Provider value={settings.schoolLogo||""}>
  <DBStatusBadge status={dbStatus}/>
  <div style={S.app}>
    {/* Mobile-only backdrop, closes the drawer when tapped outside it */}
    {isMobile&&sidebarOpen&&<div style={S.sidebarBackdrop} onClick={()=>setSidebarOpen(false)}/>}
    {/* SIDEBAR */}
    <aside style={S.sidebar(isMobile,sidebarOpen)}>
      <div style={S.sidebarLogo}>
        <SchoolLogoImg size={64} bg="rgba(255,255,255,0.1)" round={true}/>
        <div style={S.schoolName}>{SCHOOL_NAME}</div>
        <div style={S.schoolSub}>{SCHOOL_MOTTO}</div>
        <div style={{marginTop:7,background:"rgba(183,134,44,0.15)",borderRadius:6,padding:"3px 9px",display:"inline-block"}}>
          <span style={{color:C.goldLight,fontSize:9,fontWeight:600}}>{CURRENT_SESSION} · {CURRENT_TERM}</span>
        </div>
      </div>

      {sections.map(sec=>(
        <div key={sec} style={S.navSection}>
          <div style={S.navLabel}>{sec}</div>
          {visibleNav.filter(n=>n.section===sec).map(n=>(
            <div key={n.id} style={S.navItem(page===n.id)} onClick={()=>navigate(n.id)}>
              <Icon name={n.icon} size={14} color={page===n.id?C.goldLight:"rgba(255,255,255,0.5)"}/>
              {n.label}
              {n.id==="welfare"&&todayBdays>0&&<span style={{...S.badge("gold"),fontSize:8,marginLeft:"auto",padding:"1px 4px"}}>{todayBdays}🎂</span>}
            </div>
          ))}
        </div>
      ))}

      <div style={{marginTop:"auto",padding:"12px 14px",borderTop:"1px solid rgba(255,255,255,0.08)"}}>
        <div style={{color:"rgba(255,255,255,0.5)",fontSize:9,marginBottom:2}}>Logged in as:</div>
        <div style={{color:C.goldLight,fontSize:11,fontWeight:600}}>{currentUser.name}</div>
        <div style={{...S.badge(isRoot?"gold":"blue"),fontSize:9,marginTop:4,display:"inline-block"}}>{isRoot?"🔑 Root Admin":currentUser.role}</div>
        <button style={{...S.btn("danger"),fontSize:10,padding:"4px 10px",marginTop:8,display:"block",width:"100%"}} onClick={()=>{setAuthToken(null);setCurrentUser(null);setPage("dashboard");}}>Logout</button>
      </div>
    </aside>

    {/* MAIN AREA */}
    <main style={S.main}>
      <div style={S.topbar}>
        <div style={{...S.row,gap:8}}>
          {isMobile&&<button style={S.hamburgerBtn} onClick={()=>setSidebarOpen(true)} aria-label="Open menu"><Icon name="menu" size={20} color={C.primaryDark}/></button>}
          {page!=="dashboard"&&<button style={{...S.btn("ghost"),fontSize:11,padding:"4px 8px",color:C.textMuted}} onClick={()=>setPage("dashboard")}>← Dashboard</button>}
          <div style={S.pageTitle}>{PAGE_TITLES[page]||"Dashboard"}</div>
        </div>
        <div style={S.row}>
          {isRoot&&<span style={{...S.badge("gold"),fontSize:10}}>🔑 Root Admin</span>}
          <span style={S.sessionBadge}>{CURRENT_SESSION} · {CURRENT_TERM}</span>
        </div>
      </div>
      <div style={S.content(isMobile)}>
        {page==="analytics"&&(userCanAccess(currentUser,"analytics")?<AnalyticsModule students={students} attendance={attendance} results={results} settings={settings}/>:<AccessDenied/>)}
        {page==="dashboard"&&<DashboardHome students={students} results={results} fees={fees} attendance={attendance} staff={staff} settings={settings} currentUser={currentUser} onNavigate={navigate}/>}
        {page==="students"&&(userCanAccess(currentUser,"students")?<StudentsModule students={students} setStudents={setStudents}/>:<AccessDenied/>)}
        {page==="attendance"&&(userCanAccess(currentUser,"attendance")?<AttendanceModule students={students} attendance={attendance} setAttendance={setAttendance} settings={settings}/>:<AccessDenied/>)}
        {page==="results"&&(userCanAccess(currentUser,"results")?<ResultsModule students={students} results={results} setResults={setResults} settings={settings} staff={staff} currentUser={currentUser} classRemarks={classRemarks} setClassRemarks={setClassRemarks} assignments={assignments} setAssignments={setAssignments}/>:<AccessDenied/>)}
        {page==="lessons"&&(userCanAccess(currentUser,"lessons")?<LessonsModule staff={staff} students={students} lessons={lessons} setLessons={setLessons} assignments={assignments} setAssignments={setAssignments} currentUser={currentUser}/>:<AccessDenied/>)}
        {page==="studentportal"&&(userCanAccess(currentUser,"studentportal")?<StudentPortalModule students={students} staff={staff} lessons={lessons} assignments={assignments} submissions={submissions} setSubmissions={setSubmissions} results={results} setResults={setResults} currentUser={currentUser}/>:<AccessDenied/>)}
        {page==="fees"&&(userCanAccess(currentUser,"fees")?<FeesModule students={students} fees={fees} setFees={setFees} expenditure={expenditure} setExpenditure={setExpenditure} settings={settings} currentUser={currentUser}/>:<AccessDenied/>)}
        {page==="staff"&&(userCanAccess(currentUser,"staff")?<StaffModule staff={staff} setStaff={setStaff}/>:<AccessDenied/>)}
        {page==="timetable"&&(userCanAccess(currentUser,"timetable")?<TimetableModule staff={staff} timetable={timetable} setTimetable={setTimetable} settings={settings}/>:<AccessDenied/>)}
        {page==="idcards"&&(userCanAccess(currentUser,"idcards")?<IDCardsModule students={students} staff={staff} settings={settings} currentUser={currentUser}/>:<AccessDenied/>)}
        {page==="diary"&&(userCanAccess(currentUser,"diary")?<DiaryModule students={students} staff={staff} diary={diary} setDiary={setDiary} currentUser={currentUser}/>:<AccessDenied/>)}
        {page==="gallery"&&(userCanAccess(currentUser,"gallery")?<GalleryModule gallery={gallery} setGallery={setGallery} currentUser={currentUser}/>:<AccessDenied/>)}
        {page==="elibrary"&&<ELibraryModule elibrary={elibrary} setElibrary={setElibrary} currentUser={currentUser} students={students} staff={staff}/>}
        {page==="clinic"&&(userCanAccess(currentUser,"clinic")?<ClinicModule students={students} staff={staff} clinic={clinic} setClinic={setClinic} currentUser={currentUser} settings={settings}/>:<AccessDenied/>)}
        {page==="hostel"&&(userCanAccess(currentUser,"hostel")?<HostelModule students={students} staff={staff} settings={settings} currentUser={currentUser}
          hostelInventory={hostelInventory} setHostelInventory={setHostelInventory}
          hostelConsumption={hostelConsumption} setHostelConsumption={setHostelConsumption}
          hostelRequests={hostelRequests} setHostelRequests={setHostelRequests}
          hostelRooms={hostelRooms} setHostelRooms={setHostelRooms}
          hostelRollcall={hostelRollcall} setHostelRollcall={setHostelRollcall}
          hostelIncidents={hostelIncidents} setHostelIncidents={setHostelIncidents}
          expenditure={expenditure} setExpenditure={setExpenditure}
        />:<AccessDenied/>)}
        {page==="messages"&&(userCanAccess(currentUser,"messages")?<MessagesModule students={students} staff={staff} messages={messages} setMessages={setMessages}/>:<AccessDenied/>)}
        {page==="counsellor"&&(userCanAccess(currentUser,"counsellor")?<CounsellorModule students={students} staff={staff} results={results} conduct={conduct} clinic={clinic} attendance={attendance} settings={settings} currentUser={currentUser} counsellingSessions={counsellingSessions} setCounsellingSessions={setCounsellingSessions}/>:<AccessDenied/>)}
        {page==="welfare"&&(userCanAccess(currentUser,"welfare")?<WelfareModule students={students} staff={staff} conduct={conduct} setConduct={setConduct} messages={messages} settings={settings} currentUser={currentUser}/>:<AccessDenied/>)}
        {page==="payroll"&&(userCanAccess(currentUser,"payroll")?<PayrollModule staff={staff} settings={settings} currentUser={currentUser}/>:<AccessDenied/>)}
        {page==="calendar"&&(userCanAccess(currentUser,"calendar")?<CalendarModule students={students} staff={staff} settings={settings} timetable={timetable} lessons={lessons}/>:<AccessDenied/>)}
        {page==="alumni"&&(userCanAccess(currentUser,"alumni")?<AlumniModule students={students} setStudents={setStudents} results={results} settings={settings}/>:<AccessDenied/>)}
        {page==="admissions"&&(userCanAccess(currentUser,"admissions")?<AdmissionsModule students={students} setStudents={setStudents} settings={settings} currentUser={currentUser} applications={applications} setApplications={setApplications}/>:<AccessDenied/>)}
        {page==="exams"&&(userCanAccess(currentUser,"exams")?<ExamModule students={students} results={results} setResults={setResults} settings={settings} currentUser={currentUser} exams={exams} setExams={setExams} examMarks={examMarks} setExamMarks={setExamMarks} cbtEnabled={cbtEnabled} setCbtEnabled={setCbtEnabled}/>:<AccessDenied/>)}
        {page==="settings"&&(userCanAccess(currentUser,"settings")?<SettingsModule settings={settings} setSettings={setSettings} currentUser={currentUser} setCurrentUser={setCurrentUser}/>:<AccessDenied/>)}
      </div>
    </main>
  </div>
  </LogoContext.Provider>);
}
