import { firebaseConfig } from "./firebase-config.js";

const B = "https://www.gstatic.com/firebasejs/10.14.1/";
const [
  { initializeApp, deleteApp },
  { initializeAuth, inMemoryPersistence, getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged },
  { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, onSnapshot, query, where, writeBatch, arrayUnion }
] = await Promise.all([
  import(B + "firebase-app.js"),
  import(B + "firebase-auth.js"),
  import(B + "firebase-firestore.js")
]);

const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, { persistence: inMemoryPersistence });
const db = getFirestore(app);

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toLocaleDateString("en-CA");
const authAddressFromUsername = username => `${username.trim().toLowerCase()}@workdesk.app`;
const fmtDate = d => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—");
const fmtTaskDeadline = task => {
  if (!task.quickDeadlineAt) return fmtDate(task.deadline);
  const deadline = new Date(task.quickDeadlineAt);
  return Number.isFinite(deadline.getTime())
    ? deadline.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" })
    : "—";
};
const PAGES = { overview: "Overview", tasks: "My Tasks", staff: "Staff Management", alltasks: "All Staff Tasks & History", accounttasks: "Account Tasks", review: "Review" };
const STATUS = ["Pending", "In Progress", "Pending Review", "Corrections Requested", "Completed"];
const ACTIVE_TASK_STATUSES = ["Pending", "In Progress", "Corrections Requested"];
const REASONS = ["Waiting for client documents", "Waiting for information", "Waiting for approval", "Data mismatch", "Technical issue", "Workload / insufficient time", "Other"];

let me = null, users = [], tasks = [], page = "overview", unsubs = [], settingUp = false;
let fq = "", fst = "", cur = null;
let workspaceUpdateFrame = 0, taskSearchTimer = 0, accountTaskSearch = "", accountTaskStaffUid = "";
window.workdeskState = { users, tasks };

function publishWorkspaceState() {
  window.workdeskState = { users, tasks };
  window.dispatchEvent(new CustomEvent("workdesk:data", { detail: window.workdeskState }));
}

function scheduleWorkspaceUpdate() {
  if (workspaceUpdateFrame) return;
  workspaceUpdateFrame = requestAnimationFrame(() => {
    workspaceUpdateFrame = 0;
    render();
    publishWorkspaceState();
  });
}

$("todayLabel").textContent = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(new Date());
$("navigation").insertAdjacentHTML("beforeend", `<button class="nav-link admin-only" data-page="review">✔ <span>Review</span><b class="badge hidden" id="revBadge"></b></button>`);
Object.assign(PAGES, { reports: "Reports" });
$("navigation").insertAdjacentHTML("beforeend", `<button class="nav-link" data-page="reports">▥ <span>Reports</span></button>`);
document.querySelector(".top-actions").insertAdjacentHTML("afterbegin", `<button class="bell" id="bell" aria-label="Notifications">🔔<b class="badge hidden" id="bellN"></b></button>`);

function banner(msg) { const b = $("banner"); b.textContent = msg || ""; b.classList.toggle("hidden", !msg); }
function toast(m) {
  let el = $("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = m; el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 2600);
}
function showApp(on) {
  document.body.classList.toggle("out", !on);
  $("loginView").classList.toggle("hidden", on);
  $("appView").classList.toggle("hidden", !on);
}

/* ---------- AUTH ---------- */
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    const username = $("username").value.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,}$/.test(username)) throw new Error("Enter a valid username.");
    await signInWithEmailAndPassword(auth, authAddressFromUsername(username), $("password").value);
  } catch (err) {
    $("loginError").textContent = ["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password", "auth/invalid-email"].includes(err.code)
      ? "Username or password is incorrect." : "Sign-in failed: " + err.message;
  }
});

$("toggleSetup").addEventListener("click", () => {
  const showSetup = $("setupForm").classList.contains("hidden");
  $("setupForm").classList.toggle("hidden", !showSetup);
  $("loginForm").classList.toggle("hidden", showSetup);
  $("toggleSetup").textContent = showSetup ? "← Back to sign in" : "First time here? Set up admin";
});

$("setupForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("setupError").textContent = "";
  settingUp = true;
  try {
    const name = $("sName").value.trim(), user = $("sUser").value.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,}$/.test(user)) throw new Error("Username: 3+ letters/numbers (no spaces).");
    const cred = await createUserWithEmailAndPassword(auth, authAddressFromUsername(user), $("sPass").value);
    const batch = writeBatch(db);
    batch.set(doc(db, "users", cred.user.uid), { empId: "EMP001", name, username: user, role: "admin", active: true, accountTaskAccess: false, mobile: "", joiningDate: today(), createdAt: new Date().toISOString() });
    batch.set(doc(db, "meta", "setup"), { done: true, by: cred.user.uid, at: new Date().toISOString() });
    await batch.commit();
    settingUp = false;
    await boot(cred.user);
  } catch (err) {
    settingUp = false;
    $("setupError").textContent = err.code === "permission-denied" || /permission/i.test(err.message)
      ? "Setup is already done. Please sign in." : err.message;
  }
});

$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async u => {
  if (settingUp) return;
  if (!u) { cleanup(); showApp(false); return; }
  await boot(u);
});

function cleanup() {
  unsubs.forEach(f => f()); unsubs = [];
  me = null; users = []; tasks = [];
  publishWorkspaceState();
  banner("");
}

async function boot(u) {
  cleanup();
  try {
    const snap = await getDoc(doc(db, "users", u.uid));
    if (!snap.exists() || snap.data().active === false) {
      await signOut(auth);
      $("loginError").textContent = "This account is inactive or not registered. Contact Admin.";
      return;
    }
    me = { uid: u.uid, ...snap.data() };
  } catch (err) { banner("Could not load your profile: " + err.message); await signOut(auth); return; }

  const isAdmin = me.role === "admin";
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", !isAdmin));
  publishWorkspaceState();
  $("sideName").textContent = me.name;
  $("sideRole").textContent = isAdmin ? "Administrator" : "Staff · " + me.empId;
  $("avatar").textContent = $("topAvatar").textContent = me.name[0].toUpperCase();
  $("welcomeTitle").textContent = "Welcome back, " + me.name.split(" ")[0];
  $("welcomeSubtitle").textContent = isAdmin ? "Overview of the whole office." : "Your personal work summary.";
  const onErr = e => banner("Live data error: " + e.message);
  unsubs.push(onSnapshot(doc(db, "users", me.uid), snapshot => {
    if (!snapshot.exists() || snapshot.data().active === false) {
      banner("This account has been deactivated. Please contact an administrator.");
      signOut(auth).catch(error => banner("Could not sign out this inactive account: " + error.message));
      return;
    }
    me = { uid: u.uid, ...snapshot.data() };
    $("sideName").textContent = me.name;
    $("welcomeTitle").textContent = "Welcome back, " + me.name.split(" ")[0];
    publishWorkspaceState();
    scheduleWorkspaceUpdate();
  }, onErr));
  if (isAdmin) {
    unsubs.push(onSnapshot(collection(db, "users"), s => { users = s.docs.map(d => ({ uid: d.id, ...d.data() })); scheduleWorkspaceUpdate(); }, onErr));
    unsubs.push(onSnapshot(collection(db, "tasks"), s => { tasks = mapTasks(s); scheduleWorkspaceUpdate(); }, onErr));
  } else {
    unsubs.push(onSnapshot(query(collection(db, "tasks"), where("assignedTo", "==", me.uid)), s => { tasks = mapTasks(s); scheduleWorkspaceUpdate(); }, onErr));
  }
  showApp(true);
  go("overview");
}
const mapTasks = s => s.docs.map(d => {
  const task = { id: d.id, ...d.data() };
  return task.assignmentType === "Self Assigned" && task.status === "Pending Review"
    ? { ...task, status: "Completed", reviewStatus: "Not Required" }
    : task;
}).sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));

/* ---------- NAVIGATION ---------- */
function go(p) {
  page = p; fq = ""; fst = p === "tasks" ? "active" : ""; accountTaskSearch = ""; accountTaskStaffUid = "";
  window.workdeskFeaturePage = "";
  document.querySelectorAll(".nav-link").forEach(b => b.classList.toggle("active", b.dataset.page === p));
  $("pageTitle").textContent = PAGES[p];
  $("sidebar").classList.remove("open");
  if (matchMedia("(max-width: 720px)").matches) {
    document.body.classList.remove("sidebar-open");
    $("menuBtn").setAttribute("aria-expanded", "false");
    $("menuBtn").setAttribute("aria-label", "Open menu");
  }
  render();
}
$("navigation").addEventListener("click", e => { const b = e.target.closest(".nav-link"); if (b) go(b.dataset.page); });
const initialSidebarOpen = !matchMedia("(max-width: 720px)").matches && !document.body.classList.contains("sidebar-collapsed");
$("menuBtn").setAttribute("aria-expanded", String(initialSidebarOpen));
$("menuBtn").setAttribute("aria-label", initialSidebarOpen ? "Close menu" : "Open menu");
$("menuBtn").addEventListener("click", () => {
  const sidebar = $("sidebar");
  const button = $("menuBtn");
  const isMobile = matchMedia("(max-width: 720px)").matches;
  const open = isMobile ? !sidebar.classList.contains("open") : document.body.classList.contains("sidebar-collapsed");
  if (isMobile) {
    sidebar.classList.toggle("open", open);
    document.body.classList.toggle("sidebar-open", open);
  } else {
    document.body.classList.toggle("sidebar-collapsed", !open);
    sidebar.classList.toggle("open", open);
  }
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", open ? "Close menu" : "Open menu");
});
/* ---------- RENDER ---------- */
const tagClass = s => ({ Pending: "pending", "In Progress": "progress", Completed: "completed", "Pending Review": "review", "Corrections Requested": "corr" }[s] || "pending");
const mine = () => tasks.filter(t => t.assignedTo === me.uid);
const filt = list => list.filter(t => (fst === "active" ? ACTIVE_TASK_STATUSES.includes(t.status) : !fst || t.status === fst) &&
  (!fq || `${t.title} ${t.assignedToName || ""} ${t.description || ""}`.toLowerCase().includes(fq)));

function render() {
  if (!me) return;
  const isAdmin = me.role === "admin";
  if (["staff", "alltasks", "accounttasks", "review"].includes(page) && !isAdmin) return go("overview");
  const n = tasks.filter(t => t.status === "Pending Review" && t.assignmentType !== "Self Assigned").length;
  $("revBadge").textContent = n; $("revBadge").classList.toggle("hidden", !n || !isAdmin);
  bell();
  if (window.workdeskFeaturePage) return;
  const v = $("view");
  if (page === "overview") v.innerHTML = overview(isAdmin);
  else if (page === "tasks") v.innerHTML = tasksPanel("My Tasks", mine(), false);
  else if (page === "alltasks") v.innerHTML = tasksPanel("All Staff Tasks & History", tasks, true, true);
  else if (page === "accounttasks") v.innerHTML = accountTasksView();
  else if (page === "review") {
    const reviewTasks = tasks.filter(task => task.status === "Pending Review" && task.assignmentType !== "Self Assigned");
    const staffSubmitting = new Set(reviewTasks.map(task => task.assignedTo).filter(Boolean)).size;
    v.innerHTML = `<div class="review-page">
      <header class="review-intro"><div><p class="eyebrow">TASK QUALITY</p><h2>Review queue</h2><p class="muted">Check submitted work, approve completion, or return it with clear corrections.</p></div><span class="review-queue-badge">${reviewTasks.length} awaiting review</span></header>
      <div class="review-summary-grid"><article class="review-summary-card"><span>Ready for review</span><strong>${reviewTasks.length}</strong><small>Admin-assigned tasks submitted</small></article><article class="review-summary-card is-people"><span>Staff submitting</span><strong>${staffSubmitting}</strong><small>Team members with work to review</small></article></div>
      <article class="panel review-queue-panel"><div class="panel-heading"><div><h3>Submitted tasks</h3><p class="muted">Review details and take action for each task.</p></div></div>${taskTable(reviewTasks, true)}</article>
    </div>`;
  }
  else if (page === "staff") v.innerHTML = staffView();
  else if (page === "reports") v.innerHTML = reportsView();
}

function tasksPanel(title, list, who, includeHistory = false) {
  cur = { list, who, includeHistory };
  const myTasks = page === "tasks";
  const taskStatusOptions = myTasks
    ? `<option value="active" ${fst === "active" ? "selected" : ""}>Active tasks</option><option value="" ${fst === "" ? "selected" : ""}>All statuses</option>${STATUS.map(s => `<option ${s === fst ? "selected" : ""}>${s}</option>`).join("")}`
    : `<option value="">All statuses</option>${STATUS.map(s => `<option ${s === fst ? "selected" : ""}>${s}</option>`).join("")}`;
  const taskAction = page === "alltasks"
    ? `<button class="primary quick-task-button" data-act="create-quick-task">⚡ Quick task · 15 min</button><button class="primary" data-act="create-assigned-task">＋ Create task</button><button class="primary" data-act="create-account-task">＋ Account task</button>`
    : page === "tasks"
      ? `<button class="primary" data-act="create-own-task">＋ ${me.role === "admin" ? "Create my task" : "Create task"}</button>${me.role === "admin" || me.accountTaskAccess === true ? `<button class="primary" data-act="create-account-task">＋ Account task</button>` : ""}`
      : "";
  return `<article class="panel"><div class="panel-heading"><h3>${title}</h3>
    <div class="tools"><input id="q" placeholder="Search tasks…" value="${esc(fq)}">
    <select id="fs">${taskStatusOptions}</select>
    ${taskAction}<button class="ghost" data-act="export">⤓ Excel</button></div></div><div id="tbl">${page === "alltasks" ? taskTablesByDate(filt(list), who, includeHistory) : myTasks ? myTaskTablesByDate(filt(list), who) : taskTable(filt(list), who, includeHistory)}</div></article>`;
}
const refreshTbl = () => {
  if (!$("tbl") || !cur) return;
  const list = filt(cur.list);
  $("tbl").innerHTML = page === "alltasks"
    ? taskTablesByDate(list, cur.who, cur.includeHistory)
    : page === "tasks" ? myTaskTablesByDate(list, cur.who) : taskTable(list, cur.who, cur.includeHistory);
};
document.addEventListener("input", e => {
  if (e.target.id === "q") {
    fq = e.target.value.toLowerCase().trim();
    clearTimeout(taskSearchTimer);
    taskSearchTimer = setTimeout(refreshTbl, 100);
  }
  if (e.target.id === "accountTaskSearch") {
    accountTaskSearch = e.target.value.toLowerCase().trim();
    refreshAccountTaskCards();
  }
});
document.addEventListener("change", e => { if (e.target.id === "fs") { fst = e.target.value; refreshTbl(); } });

setInterval(() => {
  const hasOpenQuickTasks = tasks.some(t => t.quickDeadlineAt && !["Completed", "Pending Review"].includes(t.status));
  if (!me || !hasOpenQuickTasks) return;
  if (["alltasks", "tasks"].includes(page)) refreshTbl();
  else if (page === "overview") render();
}, 60_000);

function overview(isAdmin) {
  cur = null;
  const list = isAdmin ? tasks : mine(), t0 = today();
  const open = list.filter(t => ["Pending", "In Progress"].includes(t.status)).length;
  const rated = list.filter(t => t.rating && (isAdmin ? t.assignedTo !== me.uid : true));
  const avg = rated.length ? (rated.reduce((a, t) => a + t.rating, 0) / rated.length).toFixed(1) : "—";
  const cards = isAdmin ? [
    ["Assigned today", list.filter(t => t.assignedDate === t0).length],
    ["Completed today", list.filter(t => t.completedDate === t0).length],
    ["Still pending", open],
    ["Awaiting review", list.filter(t => t.status === "Pending Review" && t.assignmentType !== "Self Assigned").length],
    ["Returned for corrections", list.filter(t => t.status === "Corrections Requested").length],
    ["Avg staff self-rating /10", avg]
  ] : [
    ["Total assigned", list.length],
    ["Completed", list.filter(t => ["Completed", "Pending Review"].includes(t.status)).length],
    ["Pending", list.filter(t => t.status === "Pending").length],
    ["In progress", list.filter(t => t.status === "In Progress").length],
    ["Needs corrections", list.filter(t => t.status === "Corrections Requested").length],
    ["Avg self-rating /10", avg]
  ];
  return `<div class="stat-grid three">${cards.map(c => `<div class="stat-card"><div class="stat-top"><span>${c[0]}</span></div><div class="stat-value">${c[1]}</div></div>`).join("")}</div>
  <article class="panel"><div class="panel-heading"><div><h3>Recent tasks</h3><p class="muted">Latest activity</p></div></div>${taskTable(list.slice(0, 6), isAdmin)}</article>`;
}

function taskTable(list, showWho, includeHistory = false, showCarryover = false) {
  if (!list.length) return `<div class="empty-state"><div>☷</div><strong>Nothing here</strong><p class="muted">No tasks match this view.</p></div>`;
  const admin = me.role === "admin";
  const rows = list.map(t => {
    const own = t.assignedTo === me.uid;
    const quickDeadline = t.quickDeadlineAt ? new Date(t.quickDeadlineAt) : null;
    const quickDeadlineValid = quickDeadline && Number.isFinite(quickDeadline.getTime());
    const late = (quickDeadlineValid ? quickDeadline < new Date() : t.deadline && t.deadline < today()) &&
      !["Completed", "Pending Review"].includes(t.status);
    let acts = "";
    if (!t.accountTask && own && ["Pending", "Corrections Requested"].includes(t.status)) acts += `<button class="mini" data-act="start" data-id="${t.id}">${t.status === "Pending" ? "Start" : "Restart"}</button>`;
    if (!t.accountTask && own && ["Pending", "In Progress"].includes(t.status)) acts += `<button class="mini ok" data-act="complete" data-id="${t.id}">Complete</button>`;
    if (!t.accountTask && own && t.status === "In Progress") acts += `<button class="mini warn" data-act="pending" data-id="${t.id}">Pending</button>`;
    if (admin && t.status === "Pending Review" && t.assignmentType !== "Self Assigned") acts += `<button class="mini ok" data-act="approve" data-id="${esc(t.id)}">Approve</button><button class="mini warn" data-act="ret" data-id="${esc(t.id)}">Return</button>`;
    const editable = admin || own;
    const deletable = admin || (own && t.assignedBy === me.uid && ["Self Assigned", "Account Task"].includes(t.assignmentType));
    if (t.accountTask && (admin || own)) {
      acts += `<button class="mini" data-act="account-stage" data-id="${esc(t.id)}">Update stage</button>`;
      acts += `<button class="mini" data-act="add-account-stage" data-id="${esc(t.id)}">＋ Add stage</button>`;
    }
    if (editable) acts += `<button class="mini task-edit-icon" type="button" data-act="edit-task" data-id="${esc(t.id)}" aria-label="Edit ${esc(t.title)}" title="Edit task"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button>`;
    const note = t.pendingReason && t.status === "Pending" ? `<small class="muted">${esc(t.pendingReason)}</small>` : "";
    const rev = t.status === "Corrections Requested" && t.reviewRemarks ? `<small class="muted">Admin: ${esc(t.reviewRemarks)}</small>` : "";
    const carry = showCarryover && ACTIVE_TASK_STATUSES.includes(t.status) && t.assignedDate && t.assignedDate < today()
      ? `<small class="carry-label">Carried forward · ${esc(fmtDate(t.assignedDate))}</small>` : "";
    const stages = t.accountTask ? `<small class="account-task-label">Shop / account: ${esc(t.shopName || "—")}</small><small class="account-stage-list">${(t.accountStages || []).map((stage, index) => `<span class="${stage.status === "Completed" ? "is-done" : ""}">Stage ${index + 1}: ${esc(stage.name)} · ${esc(stage.status || "Pending")}</span>`).join("")}</small>` : "";
    const history = includeHistory ? `<details class="inline-history"><summary>Task history · ${(t.history || []).length} updates</summary>${t.history?.length ? `<ol>${t.history.map(item => `<li><b>${esc(item.action)}</b> · ${esc(item.by)} · ${esc((item.at || "").replace("T", " ").slice(0, 16))}${item.remarks ? `<small>${esc(item.remarks)}</small>` : ""}</li>`).join("")}</ol>` : `<small class="muted">No activity recorded.</small>`}</details>` : "";
    return `<tr><td class="task-name">${esc(t.title)}${t.quickTask ? `<small class="quick-task-tag">⚡ 15-minute task</small>` : ""}${stages}${t.description ? `<small class="muted">${esc(t.description)}</small>` : ""}${carry}${note}${rev}${history}</td>
      ${showWho ? `<td>${esc(t.assignedToName)}</td>` : ""}
      ${includeHistory ? `<td>${t.assignmentType === "Self Assigned" ? "Self assigned" : t.accountTask ? "Shop account" : "Admin assigned"}</td>` : ""}
      <td><span class="tag ${(t.priority || "Medium").toLowerCase()}">${esc(t.priority || "Medium")}</span></td>
      <td><span class="tag ${tagClass(t.status)}">${esc(t.status)}</span></td>
      <td>${fmtDate(t.assignedDate)}</td><td class="${late ? "late" : ""}">${t.quickDeadlineAt ? `15 min · ${esc(fmtTaskDeadline(t))}` : t.deadline ? fmtDate(t.deadline) : "—"}${late ? " ⚠" : ""}</td><td class="acts">${acts}</td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Task</th>${showWho ? "<th>Assigned to</th>" : ""}${includeHistory ? "<th>Task source</th>" : ""}<th>Priority</th><th>Status</th><th>Assigned</th><th>Deadline</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function myTaskTablesByDate(list, showWho) {
  if (!list.length) return taskTable(list, showWho);
  const groups = new Map();
  for (const task of list) {
    const isCarryover = ACTIVE_TASK_STATUSES.includes(task.status) && task.assignedDate && task.assignedDate < today();
    const date = isCarryover ? today()
      : ["Completed", "Pending Review"].includes(task.status) ? task.completedDate || task.assignedDate || ""
        : task.assignedDate || "";
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(task);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, items]) => {
    const label = date ? new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "Date not recorded";
    const carriedCount = items.filter(task => ACTIVE_TASK_STATUSES.includes(task.status) && task.assignedDate && task.assignedDate < today()).length;
    return `<section class="task-date-group"><div class="task-date-heading"><h3>${esc(label)}</h3><span>${items.length} task${items.length === 1 ? "" : "s"}${carriedCount ? ` · ${carriedCount} carried` : ""}</span></div>${taskTable(items, showWho, false, true)}</section>`;
  }).join("");
}

function taskTablesByDate(list, showWho, includeHistory = false) {
  if (!list.length) return taskTable(list, showWho, includeHistory);
  const groups = new Map();
  for (const task of list) {
    const date = task.assignedDate || "";
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(task);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, items]) => {
    const label = date ? new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "Date not recorded";
    return `<section class="task-date-group"><div class="task-date-heading"><h3>${esc(label)}</h3><span>${items.length} task${items.length === 1 ? "" : "s"}</span></div>${taskTable(items, showWho, includeHistory)}</section>`;
  }).join("");
}

function staffView() {
  cur = null;
  const rows = users.slice().sort((a, b) => (a.empId || "").localeCompare(b.empId || "")).map(u => `<tr>
    <td>${esc(u.empId)}</td><td class="task-name">${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.mobile || "—")}</td>
    <td>${esc(u.role)}</td><td><span class="tag ${u.active !== false ? "completed" : "high"}">${u.active !== false ? "Active" : "Inactive"}</span></td>
    <td class="acts"><button class="mini" data-act="edit" data-id="${esc(u.uid)}">Edit</button></td></tr>`).join("");
  return `<article class="panel"><div class="panel-heading"><div><h3>Staff</h3><p class="muted">Edit a staff account to manage access to staged shop-account tasks.</p></div><button class="primary" data-act="addstaff">＋ Add staff</button></div>
  <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Username</th><th>Mobile</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
}

function refreshAccountTaskCards() {
  const container = $("accountTaskCards");
  if (container) container.innerHTML = accountTaskContent(tasks.filter(task => task.accountTask === true));
  const heading = document.querySelector(".account-tasks-heading");
  if (heading) {
    const title = heading.querySelector("h3"), description = heading.querySelector(".muted"), search = $("accountTaskSearch");
    const person = accountTaskStaffUid ? personForAccountTask(accountTaskStaffUid) : null;
    if (title) title.textContent = accountTaskStaffUid ? `${person?.name || "Staff"} account tasks` : "Select a staff member";
    if (description) description.textContent = accountTaskStaffUid
      ? "View all shop accounts assigned to this staff member."
      : "Choose a staff card to view all their shop account tasks.";
    if (search) {
      search.placeholder = accountTaskStaffUid ? "Search this staff member’s shops…" : "Search staff or shops…";
      search.setAttribute("aria-label", accountTaskStaffUid ? "Search selected staff account tasks" : "Search staff and account tasks");
    }
  }
}

function accountTasksView() {
  cur = null;
  const accountTasks = tasks.filter(task => task.accountTask === true);
  const activeCount = accountTasks.filter(task => task.status !== "Completed").length;
  const selectedStaffName = personForAccountTask(accountTaskStaffUid)?.name
    || accountTasks.find(task => task.assignedTo === accountTaskStaffUid)?.assignedToName
    || "Staff";
  return `<div class="account-tasks-page">
    <header class="review-intro"><div><p class="eyebrow">SHOP ACCOUNT TRACKING</p><h2>Account tasks by staff</h2><p class="muted">See every shop account and its current processing stage, grouped by assigned staff member.</p></div></header>
    <div class="review-summary-grid">
      <article class="review-summary-card"><span>Shop accounts</span><strong>${accountTasks.length}</strong><small>All assigned account tasks</small></article>
      <article class="review-summary-card is-open"><span>In progress</span><strong>${activeCount}</strong><small>Not yet completed</small></article>
      <article class="review-summary-card is-complete"><span>Completed</span><strong>${accountTasks.length - activeCount}</strong><small>All stages completed</small></article>
    </div>
    <article class="panel account-tasks-panel">
      <div class="panel-heading account-tasks-heading"><div><h3>${accountTaskStaffUid ? `${esc(selectedStaffName)} account tasks` : "Select a staff member"}</h3><p class="muted">${accountTaskStaffUid ? "View all shop accounts assigned to this staff member." : "Choose a staff card to view all their shop account tasks."}</p></div>
        <label class="account-task-search"><span aria-hidden="true">⌕</span><input id="accountTaskSearch" type="search" placeholder="${accountTaskStaffUid ? "Search this staff member’s shops…" : "Search staff or shops…"}" value="${esc(accountTaskSearch)}" aria-label="${accountTaskStaffUid ? "Search selected staff account tasks" : "Search staff and account tasks"}"></label>
      </div>
      <div id="accountTaskCards">${accountTaskContent(accountTasks)}</div>
    </article>
  </div>`;
}

function accountTaskContent(list) {
  const groups = new Map();
  for (const task of list) {
    const uid = task.assignedTo || task.assignedToName || "unassigned";
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(task);
  }

  if (accountTaskStaffUid) {
    const staffTasks = groups.get(accountTaskStaffUid) || [];
    const matchingTasks = staffTasks.filter(task => !accountTaskSearch || `${task.shopName || ""} ${task.title || ""} ${task.description || ""}`.toLowerCase().includes(accountTaskSearch));
    const person = personForAccountTask(accountTaskStaffUid);
    const staffName = person?.name || staffTasks[0]?.assignedToName || "Former staff";
    return `<div class="account-staff-detail">
      <div class="account-staff-detail-heading"><button class="ghost" data-act="account-staff-back">← All staff</button><div><h4>${esc(staffName)}</h4><p class="muted">${matchingTasks.length} of ${staffTasks.length} account task${staffTasks.length === 1 ? "" : "s"}</p></div></div>
      ${matchingTasks.length ? `<div class="account-shop-grid">${matchingTasks.map(accountTaskCard).join("")}</div>` : `<div class="empty-state"><div>▣</div><strong>${staffTasks.length ? "No matching shop accounts" : "No account tasks assigned"}</strong><p class="muted">${staffTasks.length ? "Try another shop or task name." : "This staff member has no account tasks yet."}</p></div>`}
    </div>`;
  }

  const staff = users.filter(person => person.role === "staff" && (person.active !== false || groups.has(person.uid)));
  const known = new Set(staff.map(person => person.uid));
  for (const uid of groups.keys()) {
    if (known.has(uid)) continue;
    const person = personForAccountTask(uid);
    staff.push(person || { uid, name: groups.get(uid)[0]?.assignedToName || "Unassigned", role: "staff", active: false });
  }
  const filtered = staff.filter(person => {
    if (!accountTaskSearch) return true;
    const assigned = groups.get(person.uid) || [];
    return `${person.name || ""} ${person.empId || ""} ${assigned.map(task => `${task.shopName || ""} ${task.title || ""} ${task.description || ""}`).join(" ")}`.toLowerCase().includes(accountTaskSearch);
  }).sort((a, b) => (a.empId || "").localeCompare(b.empId || "") || (a.name || "").localeCompare(b.name || ""));
  if (!filtered.length) return `<div class="empty-state"><div>▣</div><strong>${staff.length ? "No matching staff or shops" : "No staff accounts yet"}</strong><p class="muted">${staff.length ? "Try another staff or shop name." : "Staff members will appear here."}</p></div>`;

  return `<div class="account-staff-grid">${filtered.map(person => {
    const uid = person.uid;
    const staffTasks = groups.get(uid) || [];
    const completed = staffTasks.filter(task => task.status === "Completed").length;
    const empId = person.empId ? ` · ${esc(person.empId)}` : "";
    const name = person.name || "Former staff";
    return `<button type="button" class="account-staff-card" data-act="view-account-staff" data-id="${esc(uid)}" aria-label="View all account tasks for ${esc(name)}">
      <span class="account-staff-avatar">${esc(name.slice(0, 1).toUpperCase())}</span><span class="account-staff-copy"><strong>${esc(name)}</strong><small>${esc(person.role === "admin" ? "Administrator" : person.role === "staff" ? "Staff" : "Staff account")}${empId}</small></span><span class="account-staff-stats"><b>${staffTasks.length}</b><small>account tasks</small></span><span class="account-staff-completed">${completed} completed</span><span class="account-staff-open">View tasks →</span>
    </button>`;
  }).join("")}</div>`;
}

function personForAccountTask(uid) {
  return users.find(person => person.uid === uid) || (me?.uid === uid ? me : null);
}

function accountTaskCard(task) {
  const stages = Array.isArray(task.accountStages) ? task.accountStages : [];
  const completedStages = stages.filter(stage => stage.status === "Completed").length;
  const currentStage = stages.findIndex(stage => stage.status !== "Completed");
  const progress = stages.length ? Math.round(completedStages / stages.length * 100) : 0;
  const priorityClass = ["High", "Medium", "Low"].includes(task.priority) ? task.priority.toLowerCase() : "medium";
  const due = task.deadline ? `<span>Due ${esc(fmtDate(task.deadline))}</span>` : "";
  return `<article class="account-shop-card">
    <header class="account-shop-heading"><div><h4>${esc(task.shopName || task.title || "Unnamed shop")}</h4><small>${esc(task.title || "Account processing")}</small></div><span class="tag ${tagClass(task.status || "Pending")}">${esc(task.status || "Pending")}</span></header>
    <div class="account-shop-meta"><span>${completedStages}/${stages.length} stages</span>${due}<span class="tag ${priorityClass}">${esc(task.priority || "Medium")}</span></div>
    <div class="account-progress" role="progressbar" aria-label="Stage completion" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${progress}%"></span></div>
    ${stages.length ? `<ol class="account-stage-cards">${stages.map((stage, index) => `<li class="${stage.status === "Completed" ? "is-done" : index === currentStage ? "is-current" : ""}">
      <span class="account-stage-number">${index + 1}</span><span class="account-stage-copy"><strong>${esc(stage.name || `Stage ${index + 1}`)}</strong>${stage.remarks ? `<small>${esc(stage.remarks)}</small>` : ""}</span><span class="tag ${tagClass(stage.status || "Pending")}">${esc(stage.status || "Pending")}</span>
    </li>`).join("")}</ol>` : `<p class="muted account-no-stages">No stages have been added to this account task.</p>`}
    <footer class="account-shop-actions"><button type="button" class="mini" data-act="account-stage" data-id="${esc(task.id)}">Update stage</button><button type="button" class="mini" data-act="add-account-stage" data-id="${esc(task.id)}">＋ Add stage</button></footer>
  </article>`;
}

/* ---------- DIALOG ---------- */
function openDlg(title, body, submit, ok = "Saved", label = "Save") {
  document.querySelector(".edit-delete-action")?.remove();
  $("dlgTitle").textContent = title; $("dlgBody").innerHTML = body; $("dlgErr").textContent = "";
  const btn = $("dlgForm").querySelector("[type=submit]"); btn.textContent = label;
  $("dlgForm").onsubmit = async e => {
    e.preventDefault(); $("dlgErr").textContent = ""; btn.disabled = true;
    try { await submit(new FormData($("dlgForm"))); $("dlg").close(); toast(ok); }
    catch (err) { $("dlgErr").textContent = err.code === "permission-denied" ? "Permission denied — publish the latest firestore.rules in Firebase." : err.message; }
    finally { btn.disabled = false; }
  };
  $("dlg").showModal();
  $("dlgBody").querySelector("input,select,textarea")?.focus();
}
$("dlgCancel").addEventListener("click", () => $("dlg").close());

/* ---------- ACTIONS ---------- */
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const t = tasks.find(x => x.id === b.dataset.id), id = b.dataset.id;
  ({ start: () => startTask(t), complete: () => completeDialog(t), pending: () => pendingDialog(t),
     approve: () => reviewDialog(t, true), ret: () => reviewDialog(t, false),
     addstaff: addStaffDialog,
     "create-own-task": () => newTaskDialog(false),
     "create-assigned-task": () => newTaskDialog(true),
     "create-quick-task": () => newTaskDialog(true, true),
     "create-account-task": () => newAccountTaskDialog(me.role === "admin" && page === "alltasks"),
     "view-account-staff": () => {
       accountTaskStaffUid = id;
       accountTaskSearch = "";
       if ($("accountTaskSearch")) $("accountTaskSearch").value = "";
       refreshAccountTaskCards();
     },
     "account-staff-back": () => {
       accountTaskStaffUid = "";
       accountTaskSearch = "";
       if ($("accountTaskSearch")) $("accountTaskSearch").value = "";
       refreshAccountTaskCards();
     },
     "edit-task": () => editTaskDialog(t),
     "delete-task": () => deleteTask(t),
     "account-stage": () => updateAccountStageDialog(t),
     "add-account-stage": () => addAccountStageDialog(t),
     readnotification: () => markNotificationRead(id),
     export: exportXlsx, repxlsx: () => repXlsx(id || ""), reppdf: () => printStaffReport(id), print: printCurrentReport }[b.dataset.act] || (() => {}))();
});

const hist = (action, from, to, remarks = "") => ({ action, by: me.name, byId: me.uid, at: new Date().toISOString(), from, to, remarks });
const upd = (t, data, h) => updateDoc(doc(db, "tasks", t.id), { ...data, updatedAt: new Date().toISOString(), history: arrayUnion(h) });

async function startTask(t) {
  try { await upd(t, { status: "In Progress", startedAt: new Date().toISOString() }, hist(t.status === "Pending" ? "Started" : "Restarted", t.status, "In Progress")); }
  catch (err) { banner("Could not start task: " + err.message); }
}

function pendingDialog(t) {
  openDlg("Submit pending reason", `<label>Reason</label><select name="reason" required>${REASONS.map(r => `<option>${r}</option>`).join("")}</select>
    <label>Additional explanation</label><textarea name="note" rows="3"></textarea>`,
    async f => { const note = f.get("note").trim(), why = f.get("reason");
      await upd(t, { status: "Pending", pendingReason: why + (note ? " — " + note : "") }, hist("Pending reason", t.status, "Pending", why + (note ? " — " + note : ""))); }, "Marked pending");
}

function completeDialog(t) {
  const isAdmin = me.role === "admin";
  const requiresReview = !isAdmin && t.assignmentType !== "Self Assigned";
  openDlg("Complete task", `<p class="muted">${requiresReview ? "This admin-assigned task will be sent to the administrator for review." : "This task will be marked completed without administrator review."}</p>
    <label>Completion remarks</label><textarea name="remarks" rows="3"></textarea>
    <label>Self-rating (1–10)</label><select name="rating" required><option value="">Select…</option>${[1,2,3,4,5,6,7,8,9,10].map(n => `<option>${n}</option>`).join("")}</select>`,
    async f => {
      const rating = Number(f.get("rating")); if (!rating) throw new Error("Self-rating is required.");
      const version = (t.currentVersion || 0) + 1, status = requiresReview ? "Pending Review" : "Completed", remarks = f.get("remarks").trim();
      await upd(t, { status, rating, currentVersion: version, completedAt: new Date().toISOString(), completedDate: today(), pendingReason: "",
        reviewStatus: requiresReview ? "Awaiting Review" : "Not Required", reviewRemarks: "",
        submissions: arrayUnion({ version, rating, remarks, by: me.name, at: new Date().toISOString() }) },
        hist("Completed", t.status, status, `Rating ${rating}/10. ${remarks}`));
    }, requiresReview ? "Submitted for review" : "Task completed", "Submit");
}

function reviewDialog(t, approve) {
  openDlg(approve ? "Approve task" : "Return for corrections",
    `<p class="muted"><strong>${esc(t.title)}</strong> · ${esc(t.assignedToName)}</p>
     <label>${approve ? "Remarks (optional)" : "What needs correcting? *"}</label><textarea name="remarks" rows="3" ${approve ? "" : "required"}></textarea>`,
    async f => {
      const remarks = f.get("remarks").trim();
      if (!approve && !remarks) throw new Error("Please say what needs to be corrected.");
      const status = approve ? "Completed" : "Corrections Requested";
      await upd(t, { status, reviewStatus: approve ? "Approved" : "Returned", reviewRemarks: remarks, reviewedBy: me.name, reviewedAt: new Date().toISOString() },
        hist(approve ? "Approved" : "Returned for corrections", t.status, status, remarks));
    }, approve ? "Task approved" : "Returned to staff", approve ? "Approve" : "Return");
}

function newTaskDialog(assignToStaff = me.role === "admin" && page !== "tasks", quick = false) {
  const assignable = me.role === "admin" && assignToStaff;
  if (quick && !assignable) return banner("Only an administrator can assign a quick task.");
  const list = assignable ? users.filter(u => u.role === "staff" && u.active !== false) : [me];
  if (assignable && !list.length) return banner("No active staff accounts are available to assign this task.");
  const opts = list.map(u => `<option value="${u.uid}">${esc(u.name)}${u.empId ? ` · ${esc(u.empId)}` : ""}</option>`).join("");
  openDlg(quick ? "Assign 15-minute quick task" : "Create task", `${quick ? `<p class="quick-task-note">Assign a small task to an active staff member. Its deadline will be set to 15 minutes after assignment. It remains a normal admin-assigned task and follows the usual review process.</p>` : ""}
    <label>Title *</label><input name="title" maxlength="300" required>
    <label>Description</label><textarea name="description" rows="2"></textarea>
    ${assignable ? `<label>Assign to *</label><select name="to" required><option value="" disabled selected>Select a staff member</option>${opts}</select>` : ""}
    ${quick ? `<p class="muted quick-task-priority">Priority: High · Completion target: 15 minutes</p>` : `<label>Priority</label><select name="priority"><option>High</option><option selected>Medium</option><option>Low</option></select>
    <label>Deadline (optional)</label><input type="date" name="deadline" min="${today()}">`}`,
    async f => {
      const title = f.get("title").trim(); if (!title) throw new Error("Title is required.");
      const toId = assignable ? f.get("to") : me.uid;
      const to = list.find(u => u.uid === toId) || (toId === me.uid ? me : null);
      if (!to) throw new Error("Choose who to assign this to.");
      const dl = quick ? today() : f.get("deadline") || ""; if (dl && dl < today()) throw new Error("Deadline can't be in the past.");
      const quickDeadlineAt = quick ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : "";
      const now = new Date().toISOString(), type = assignable ? "Admin Assigned" : "Self Assigned";
      await addDoc(collection(db, "tasks"), { title, description: f.get("description").trim(), taskType: quick ? "Quick Task" : "Normal",
        assignedBy: me.uid, assignedByName: me.name, assignedTo: toId, assignedToName: to.name, assignmentType: type,
        assignedDate: today(), deadline: dl, priority: quick ? "High" : f.get("priority") || "Medium", status: "Pending", pendingReason: "",
        ...(quick ? { quickTask: true, quickDeadlineAt } : {}),
        currentVersion: 0, reviewStatus: "", createdAt: now, createdMs: Date.now(),
        history: [hist("Created", "", "Pending", type + (quick ? " 15-minute quick task" : "") + " to " + to.name)] });
    }, quick ? "15-minute task assigned" : "Task created", quick ? "Assign quick task" : "Create");
}

function newAccountTaskDialog(assignToStaff = false) {
  if (me.role !== "admin" && me.accountTaskAccess !== true) return banner("You do not have permission to create account tasks. Contact an administrator.");
  const assignable = me.role === "admin" && assignToStaff;
  const list = assignable ? users.filter(person => person.role === "staff" && person.active !== false) : [me];
  if (assignable && !list.length) return banner("No active staff accounts are available to assign this account task.");
  const options = list.map(person => `<option value="${esc(person.uid)}">${esc(person.name)}${person.empId ? ` · ${esc(person.empId)}` : ""}</option>`).join("");
  openDlg("Create shop account task", `<p class="muted">Track one shop account through its stages. Add one stage name per line; the first unfinished stage is the next stage to update.</p>
    <label>Shop / account name *</label><input name="shopName" maxlength="160" required>
    <label>Work summary</label><input name="summary" maxlength="300" value="Account processing">
    <label>Description</label><textarea name="description" rows="2"></textarea>
    <label>Stages (one per line) *</label><textarea name="stages" rows="5" required>Statement entries
Credit ledger
Suspense clearing</textarea>
    ${assignable ? `<label>Assign to *</label><select name="to" required><option value="" disabled selected>Select a staff member</option>${options}</select>` : ""}
    <label>Priority</label><select name="priority"><option>High</option><option selected>Medium</option><option>Low</option></select>
    <label>Deadline (optional)</label><input type="date" name="deadline" min="${today()}">`,
    async formData => {
      const shopName = String(formData.get("shopName") || "").trim();
      const summary = String(formData.get("summary") || "").trim() || "Account processing";
      const stageNames = String(formData.get("stages") || "").split(/\r?\n/).map(name => name.trim()).filter(Boolean);
      if (!shopName) throw new Error("Shop / account name is required.");
      if (shopName.length > 160 || summary.length > 300) throw new Error("Shop name or work summary is too long.");
      if (!stageNames.length) throw new Error("Add at least one stage.");
      if (stageNames.length > 20) throw new Error("An account task can have at most 20 stages.");
      if (stageNames.some(name => name.length > 120)) throw new Error("Each stage name must be 120 characters or fewer.");
      const toId = assignable ? String(formData.get("to") || "") : me.uid;
      const assignee = list.find(person => person.uid === toId);
      if (!assignee) throw new Error("Choose an active staff member.");
      const deadline = String(formData.get("deadline") || "");
      if (deadline && deadline < today()) throw new Error("Deadline can't be in the past.");
      const now = new Date().toISOString(), stages = stageNames.map(name => ({ name, status: "Pending", remarks: "", updatedBy: "", updatedAt: "" }));
      await addDoc(collection(db, "tasks"), {
        title: summary, description: String(formData.get("description") || "").trim(), taskType: "Account Task",
        accountTask: true, shopName, accountStages: stages, currentStage: 0,
        assignedBy: me.uid, assignedByName: me.name, assignedTo: toId, assignedToName: assignee.name, assignmentType: "Account Task",
        assignedDate: today(), deadline, priority: String(formData.get("priority") || "Medium"), status: "Pending", pendingReason: "",
        currentVersion: 0, reviewStatus: "Not Required", createdAt: now, createdMs: Date.now(),
        history: [hist("Account task created", "", "Pending", `${shopName}: ${stageNames.join(" → ")} · assigned to ${assignee.name}`)]
      });
    }, "Account task created", "Create account task");
}

function editTaskDialog(task) {
  if (!task || (me.role !== "admin" && task.assignedTo !== me.uid)) {
    return banner("You do not have permission to edit this task.");
  }
  const isAdmin = me.role === "admin";
  const staffOptions = isAdmin ? `<label>Assign to</label><select name="assignedTo">${users.filter(person => person.uid === task.assignedTo || (person.active !== false && (person.role === "staff" || person.uid === me.uid))).map(person => `<option value="${esc(person.uid)}" ${person.uid === task.assignedTo ? "selected" : ""}>${esc(person.name)}${person.active === false ? " · Inactive" : ""}</option>`).join("")}</select>` : "";
  openDlg("Edit task", `${task.accountTask ? `<label>Shop / account name *</label><input name="shopName" maxlength="160" value="${esc(task.shopName || "")}" required>` : ""}
    <label>Title *</label><input name="title" maxlength="300" value="${esc(task.title)}" required>
    <label>Description</label><textarea name="description" rows="3">${esc(task.description || "")}</textarea>
    ${staffOptions}
    <label>Priority</label><select name="priority">${["High", "Medium", "Low"].map(priority => `<option ${priority === task.priority ? "selected" : ""}>${priority}</option>`).join("")}</select>
    <label>Deadline (optional)</label><input type="date" name="deadline" min="${task.deadline && task.deadline < today() ? esc(task.deadline) : today()}" value="${esc(task.deadline || "")}">`,
    async formData => {
      const title = String(formData.get("title") || "").trim(), deadline = String(formData.get("deadline") || "");
      if (!title) throw new Error("Title is required.");
      if (deadline && deadline < today() && deadline !== task.deadline) throw new Error("Deadline can't be in the past.");
      const historyItems = [hist("Task details edited", task.status, task.status, "Task details updated")];
      const updates = {
        title, description: String(formData.get("description") || "").trim(), priority: String(formData.get("priority") || "Medium"),
        deadline, updatedAt: new Date().toISOString(),
        history: arrayUnion(...historyItems)
      };
      if (task.accountTask) updates.shopName = String(formData.get("shopName") || "").trim();
      if (isAdmin) {
        const assignedTo = users.find(person => person.uid === formData.get("assignedTo"));
        if (!assignedTo || (assignedTo.active === false && assignedTo.uid !== task.assignedTo)) throw new Error("Choose an active assignee.");
        if (assignedTo.uid !== task.assignedTo) {
          updates.assignedTo = assignedTo.uid;
          updates.assignedToName = assignedTo.name;
          updates.history = arrayUnion(...historyItems, hist("Reassigned", task.assignedTo, assignedTo.uid, `Assigned to ${assignedTo.name}`));
        }
      }
      await updateDoc(doc(db, "tasks", task.id), updates);
    }, "Task updated", "Save changes");
  const canDelete = isAdmin || (task.assignedTo === me.uid && task.assignedBy === me.uid && ["Self Assigned", "Account Task"].includes(task.assignmentType));
  if (canDelete) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "ghost edit-delete-action";
    deleteButton.textContent = "Delete task";
    deleteButton.setAttribute("aria-label", `Delete ${task.title}`);
    deleteButton.addEventListener("click", async () => {
      deleteButton.disabled = true;
      try {
        if (await deleteTask(task)) $("dlg").close();
      } finally {
        deleteButton.disabled = false;
      }
    });
    document.querySelector(".dlg-actions").prepend(deleteButton);
  }
}

async function deleteTask(task) {
  if (!task || (me.role !== "admin" && !(task.assignedTo === me.uid && task.assignedBy === me.uid && ["Self Assigned", "Account Task"].includes(task.assignmentType)))) {
    return banner("You do not have permission to delete this task.");
  }
  if (!confirm(`Delete "${task.title}"? This will permanently remove its task history.`)) return false;
  try {
    await deleteDoc(doc(db, "tasks", task.id));
    toast("Task deleted");
    return true;
  } catch (error) {
    banner("Could not delete task: " + error.message);
    return false;
  }
}

function updateAccountStageDialog(task) {
  if (!task?.accountTask || (me.role !== "admin" && task.assignedTo !== me.uid)) return banner("You do not have permission to update this account task.");
  const stages = Array.isArray(task.accountStages) ? task.accountStages : [];
  if (!stages.length) return banner("This account task has no stages. Add a stage before updating it.");
  const index = stages.findIndex(stage => stage.status !== "Completed");
  const selectedIndex = index < 0 ? 0 : index;
  const selectedStage = stages[selectedIndex];
  openDlg(`Update account stage`, `<p class="muted">${esc(task.shopName || task.title)}</p>
    <label>Stage *</label><select name="stageIndex" required>${stages.map((item, stageIndex) => `<option value="${stageIndex}" ${stageIndex === selectedIndex ? "selected" : ""}>Stage ${stageIndex + 1} · ${esc(item.name)} · ${esc(item.status || "Pending")}</option>`).join("")}</select>
    <label>Stage status</label><select name="status">${["Pending", "In Progress", "Completed"].map(status => `<option ${status === (selectedStage.status || "Pending") ? "selected" : ""}>${status}</option>`).join("")}</select>
    <label>Update note (optional)</label><textarea name="remarks" rows="3"></textarea>`,
    async formData => {
      const status = String(formData.get("status"));
      const selectedIndex = Number(formData.get("stageIndex"));
      if (!Number.isInteger(selectedIndex) || !stages[selectedIndex]) throw new Error("Choose a valid stage.");
      if (!["Pending", "In Progress", "Completed"].includes(status)) throw new Error("Choose a valid stage status.");
      const remarks = String(formData.get("remarks") || "").trim(), now = new Date().toISOString();
      const updatedStages = stages.map(item => ({ ...item }));
      updatedStages[selectedIndex] = { ...updatedStages[selectedIndex], status, remarks, updatedBy: me.name, updatedAt: now };
      const currentStage = updatedStages.findIndex(item => item.status !== "Completed");
      const complete = currentStage < 0;
      const taskStatus = complete ? "Completed" : updatedStages[currentStage].status === "In Progress" ? "In Progress" : "Pending";
      const updates = {
        accountStages: updatedStages, currentStage: complete ? updatedStages.length : currentStage,
        status: taskStatus, updatedAt: now,
        history: arrayUnion(hist(`${updatedStages[selectedIndex].name} · ${status}`, task.status, taskStatus, remarks))
      };
      if (complete) { updates.completedAt = now; updates.completedDate = today(); }
      else { updates.completedAt = ""; updates.completedDate = ""; }
      await updateDoc(doc(db, "tasks", task.id), updates);
    }, "Account stage updated", "Update stage");
  $("dlgBody").querySelector('[name="stageIndex"]')?.addEventListener("change", event => {
    const updatedStage = stages[Number(event.target.value)];
    const statusSelect = $("dlgBody").querySelector('[name="status"]');
    if (updatedStage && statusSelect) statusSelect.value = updatedStage.status || "Pending";
  });
}

function addAccountStageDialog(task) {
  if (!task?.accountTask || (me.role !== "admin" && task.assignedTo !== me.uid)) return banner("You do not have permission to add a stage to this account task.");
  const stages = Array.isArray(task.accountStages) ? task.accountStages : [];
  if (stages.length >= 20) return banner("This account task already has the maximum of 20 stages.");
  openDlg("Add account stage", `<p class="muted">${esc(task.shopName || task.title)} · ${stages.length} of 20 stages</p>
    <label>New stage name *</label><input name="stageName" maxlength="120" required>
    <label>Position</label><select name="position"><option value="end" selected>Add after current stages</option><option value="next">Insert as the next stage</option></select>`,
    async formData => {
      const name = String(formData.get("stageName") || "").trim();
      if (!name || name.length > 120) throw new Error("Stage name is required and must be 120 characters or fewer.");
      if (stages.some(stage => stage.name.trim().toLowerCase() === name.toLowerCase())) throw new Error("A stage with that name already exists.");
      const nextStages = stages.slice(), stage = { name, status: "Pending", remarks: "", updatedBy: me.name, updatedAt: new Date().toISOString() };
      let nextCurrentStage = stages.findIndex(item => item.status !== "Completed");
      if (formData.get("position") === "next") {
        const firstIncomplete = stages.findIndex(item => item.status !== "Completed");
        const position = firstIncomplete < 0 ? stages.length : firstIncomplete;
        nextStages.splice(position, 0, stage);
        nextCurrentStage = position;
      } else {
        nextStages.push(stage);
        if (nextCurrentStage < 0) nextCurrentStage = stages.length;
      }
      const taskStatus = nextStages[nextCurrentStage]?.status === "In Progress" ? "In Progress" : "Pending";
      await updateDoc(doc(db, "tasks", task.id), {
        accountStages: nextStages,
        currentStage: nextCurrentStage,
        status: taskStatus,
        completedAt: "",
        completedDate: "",
        updatedAt: new Date().toISOString(),
        history: arrayUnion(hist("Account stage added", task.status, taskStatus, `Added stage: ${name}`))
      });
    }, "Account stage added", "Add stage");
}

function addStaffDialog() {
  openDlg("Add staff", `<label>Full name *</label><input name="name" required>
    <label>Username * (letters/numbers)</label><input name="username" autocomplete="off" required>
    <label>Password * (min 6)</label><input name="password" type="password" autocomplete="new-password" minlength="6" required>
    <label>Mobile (optional)</label><input name="mobile" inputmode="tel">
    <label>Joining date</label><input type="date" name="joining" value="${today()}">`,
    async f => {
      const name = f.get("name").trim(), user = f.get("username").trim().toLowerCase();
      if (!name || !/^[a-z0-9._-]{3,}$/.test(user) || f.get("password").length < 6) throw new Error("Check name, username (3+ chars, no spaces) and password (6+ chars).");
      if (users.some(u => u.username === user)) throw new Error("Username already exists.");
      const n = users.reduce((m, u) => Math.max(m, parseInt((u.empId || "").replace(/\D/g, "")) || 0), 0) + 1;
      const empId = "EMP" + String(n).padStart(3, "0");
      const sec = initializeApp(firebaseConfig, "sec" + Date.now());   // second app so Admin stays signed in
      try {
        const cred = await createUserWithEmailAndPassword(getAuth(sec), authAddressFromUsername(user), f.get("password"));
        const batch = writeBatch(db);
        batch.set(doc(db, "users", cred.user.uid), { empId, name, username: user, role: "staff", active: true, accountTaskAccess: false,
          mobile: f.get("mobile").trim(), joiningDate: f.get("joining") || today(), createdAt: new Date().toISOString() });
        await batch.commit();
        await signOut(getAuth(sec));
      } catch (err) { throw new Error(err.code === "auth/email-already-in-use" ? "Username is already in use." : err.message); }
      finally { await deleteApp(sec); }
    }, "Staff added", "Add staff");
}

/* ---------- EXCEL EXPORT ---------- */
async function loadExcel() {
  const module = await import("https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/+esm");
  const X = module.default || module;
  if (!X.utils?.book_new || !X.writeFile) throw new Error("The Excel workbook library did not load correctly.");
  return X;
}

function appendStyledSheet(X, workbook, name, rows, widths = []) {
  const sheet = X.utils.json_to_sheet(rows.length ? rows : [{ Note: "No records for this report." }]);
  const range = X.utils.decode_range(sheet["!ref"]);
  const edge = { style: "thin", color: { rgb: "D8E2F0" } };
  for (let col = range.s.c; col <= range.e.c; col++) {
    const header = sheet[X.utils.encode_cell({ r: 0, c: col })];
    if (header) header.s = {
      fill: { patternType: "solid", fgColor: { rgb: "1D376B" } },
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11 },
      alignment: { vertical: "center", wrapText: true },
      border: { bottom: { style: "medium", color: { rgb: "18A999" } } }
    };
  }
  for (let row = 1; row <= range.e.r; row++) {
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = sheet[X.utils.encode_cell({ r: row, c: col })];
      if (!cell) continue;
      cell.s = {
        fill: { patternType: "solid", fgColor: { rgb: row % 2 ? "F0F6FF" : "FFFFFF" } },
        font: { color: { rgb: "172033" }, sz: 10 },
        alignment: { vertical: "top", wrapText: true },
        border: { bottom: edge }
      };
    }
  }
  sheet["!cols"] = widths.map(wch => ({ wch }));
  sheet["!rows"] = [{ hpt: 30 }, ...Array(Math.max(0, range.e.r)).fill({ hpt: 24 })];
  if (range.e.r > 0) sheet["!autofilter"] = { ref: sheet["!ref"] };
  X.utils.book_append_sheet(workbook, sheet, name);
}

const taskReportDate = task => task.completedDate || task.assignedDate || "";
const personForUid = uid => users.find(person => person.uid === uid) || (me?.uid === uid ? me : null);
const taskDetailRows = list => list.slice().sort((a, b) =>
  taskReportDate(a).localeCompare(taskReportDate(b)) || (a.assignedToName || "").localeCompare(b.assignedToName || "") || (a.title || "").localeCompare(b.title || "")
).map(task => ({
  Date: taskReportDate(task),
  "Employee ID": personForUid(task.assignedTo)?.empId || "",
  Staff: task.assignedToName || "",
  Title: task.title || "",
  Description: task.description || "",
  "Assigned By": task.assignedByName || "",
  Type: task.assignmentType || task.taskType || "",
  Priority: task.priority || "",
  Status: task.status || "Pending",
  "Assigned Date": task.assignedDate || "",
  Deadline: task.quickDeadlineAt ? fmtTaskDeadline(task) : task.deadline || "",
  "Completed Date": task.completedDate || "",
  "Completion Remarks": (task.submissions || []).map(submission => submission.remarks).filter(Boolean).join(" | "),
  "Self Rating": task.rating || "",
  "Review Status": task.reviewStatus || "",
  "Review Remarks": task.reviewRemarks || "",
  "Pending Reason": task.pendingReason || ""
}));

async function exportXlsx() {
  const admin = me.role === "admin", list = admin && page !== "tasks" ? tasks : mine();
  if (!list.length) return toast("Nothing to export yet.");
  try {
    const X = await loadExcel();
    const wb = X.utils.book_new();
    const dates = new Map();
    for (const task of list) {
      const date = taskReportDate(task) || "Date not recorded";
      const key = `${date}\u0000${task.assignedTo}`;
      const row = dates.get(key) || { Date: date, "Employee ID": personForUid(task.assignedTo)?.empId || "", Staff: task.assignedToName || "", Tasks: 0, Completed: 0, "Admin Assigned": 0, "Self Assigned": 0 };
      row.Tasks++;
      if (task.completedDate === date && ["Completed", "Pending Review"].includes(task.status)) row.Completed++;
      if (task.assignmentType === "Self Assigned") row["Self Assigned"]++;
      else row["Admin Assigned"]++;
      dates.set(key, row);
    }
    appendStyledSheet(X, wb, "Daily Summary", [...dates.values()], [16, 16, 24, 12, 12, 16, 16]);
    appendStyledSheet(X, wb, "Tasks", taskDetailRows(list), [16, 14, 22, 32, 48, 22, 18, 12, 20, 16, 16, 16, 38, 12, 18, 38, 38]);
    appendStyledSheet(X, wb, "History", list.flatMap(task => (task.history || []).map(item => ({
      Date: (item.at || "").slice(0, 10),
      "Employee ID": personForUid(task.assignedTo)?.empId || "",
      Staff: task.assignedToName || "",
      Task: task.title || "",
      Action: item.action || "",
      By: item.by || "",
      At: (item.at || "").replace("T", " ").slice(0, 19),
      From: item.from || "",
      To: item.to || "",
      Remarks: item.remarks || ""
    }))), [16, 14, 22, 32, 24, 22, 22, 20, 20, 48]);
    if (admin) appendStyledSheet(X, wb, "Staff", users.map(person => ({
      "Emp ID": person.empId || "",
      Name: person.name || "",
      Role: person.role || "",
      Active: person.active !== false ? "Yes" : "No",
      "Assigned tasks": tasks.filter(task => task.assignedTo === person.uid).length
    })), [16, 24, 14, 12, 18]);
    X.writeFile(wb, `WorkDesk_${today()}.xlsx`);
    toast("Excel file downloaded");
  } catch (err) { banner("Excel export failed: " + err.message); }
}

/* ---------- MONTHLY REPORTS ---------- */
const stamp = s => esc((s || "").replace("T", " ").slice(0, 16));
let rm = today().slice(0, 7);
let reportStaffUid = "";
const inReportMonth = value => typeof value === "string" && value.startsWith(rm);
const monthTasks = () => tasks.filter(task =>
  inReportMonth(task.assignedDate)
  || inReportMonth(task.completedDate)
  || (task.history || []).some(item => inReportMonth(item.at))
);
const taskReportDay = task => {
  if (inReportMonth(task.completedDate)) return task.completedDate;
  if (inReportMonth(task.assignedDate)) return task.assignedDate;
  return (task.history || []).map(item => (item.at || "").slice(0, 10)).filter(inReportMonth).sort().at(-1) || "";
};
const fullDate = value => value
  ? new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
  : "Date not recorded";
function groupTasksByDate(list) {
  const groups = new Map();
  for (const task of list) {
    const date = taskReportDay(task);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(task);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
const monthlyStaff = () => {
  const reportTasks = monthTasks();
  if (me.role !== "admin") return [{ ...me, tasks: reportTasks.filter(task => task.assignedTo === me.uid) }];
  const taskUids = new Set(reportTasks.map(task => task.assignedTo).filter(Boolean));
  const people = users.filter(person =>
    (person.role === "staff" && (person.active !== false || taskUids.has(person.uid)))
    || (person.role === "admin" && (person.uid === me.uid || taskUids.has(person.uid)))
  );
  if (!people.some(person => person.uid === me.uid)) people.push(me);
  const knownUids = new Set(people.map(person => person.uid));
  const missing = [...taskUids].filter(uid => !knownUids.has(uid)).map(uid => ({
    uid,
    name: reportTasks.find(task => task.assignedTo === uid)?.assignedToName || "Former staff",
    empId: "Staff account unavailable",
    active: false
  }));
  return [...people, ...missing].map(person => ({
    ...person,
    tasks: reportTasks.filter(task => task.assignedTo === person.uid)
  })).sort((a, b) => (a.role === "admin" ? 0 : 1) - (b.role === "admin" ? 0 : 1) || (a.empId || "").localeCompare(b.empId || ""));
};
function monthRows() {
  return monthlyStaff().map(person => {
    const list = person.tasks, ratings = list.map(task => Number(task.rating)).filter(Boolean);
    return {
      "Employee ID": person.empId || "",
      Staff: person.name || "",
      Role: person.role === "admin" ? "Administrator" : person.role === "staff" ? "Staff" : "Former staff",
      "Tasks tracked": list.length,
      Assigned: list.filter(task => inReportMonth(task.assignedDate)).length,
      "Admin assigned": list.filter(task => task.assignmentType !== "Self Assigned").length,
      "Self assigned": list.filter(task => task.assignmentType === "Self Assigned").length,
      Pending: list.filter(task => task.status === "Pending").length,
      "In Progress": list.filter(task => task.status === "In Progress").length,
      "Pending Review": list.filter(task => task.status === "Pending Review").length,
      "Corrections Requested": list.filter(task => task.status === "Corrections Requested").length,
      "Submitted / completed this month": list.filter(task => inReportMonth(task.completedDate) && ["Completed", "Pending Review"].includes(task.status)).length,
      "Avg Rating": ratings.length ? +(ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1) : ""
    };
  });
}
function reportsView() {
  cur = null;
  const people = monthlyStaff();
  const rows = monthRows();
  const allTasks = people.flatMap(person => person.tasks);
  const completedThisMonth = allTasks.filter(task => inReportMonth(task.completedDate) && ["Completed", "Pending Review"].includes(task.status)).length;
  const openTasks = allTasks.filter(task => ["Pending", "In Progress", "Corrections Requested"].includes(task.status)).length;
  const reportingStaff = people.filter(person => person.role === "staff" && (person.active !== false || person.tasks.length)).length;
  const selectedUid = me.role === "admin" ? reportStaffUid : me.uid;
  const selected = people.find(person => person.uid === selectedUid);
  const staffCards = me.role === "admin" ? people.map(person => {
    const isSelected = person.uid === selectedUid;
    const open = person.tasks.filter(task => ["Pending", "In Progress", "Corrections Requested"].includes(task.status)).length;
    return `<article class="report-staff-card ${isSelected ? "is-selected" : ""}">
      <button type="button" class="report-staff-select" data-report-staff="${esc(person.uid)}" aria-expanded="${isSelected}">
        <span class="report-staff-avatar">${esc((person.name || "?").slice(0, 1).toUpperCase())}</span>
        <span class="report-staff-copy"><strong>${esc(person.name)}</strong><small>${person.role === "admin" ? "Administrator" : esc(person.empId || "Staff")} · ${person.active === false ? "Inactive" : "Active"}</small></span>
        <span class="report-staff-count"><b>${person.tasks.length}</b><small>tasks</small></span>
        <span class="report-staff-open">${open} open</span>
      </button>
      <div class="report-download-actions">
        <button type="button" class="ghost" data-act="repxlsx" data-id="${esc(person.uid)}" ${person.tasks.length ? "" : "disabled"}>⤓ Staff Excel</button>
        <button type="button" class="ghost" data-act="reppdf" data-id="${esc(person.uid)}">▤ Staff PDF</button>
      </div>
    </article>`;
  }).join("") : "";
  const taskDetails = selected ? `<article class="panel report-detail-panel"><div class="panel-heading"><div><p class="eyebrow">${esc(selected.role === "admin" ? "ADMIN REPORT" : selected.empId || "STAFF REPORT")}</p><h3>${esc(selected.name)} · ${esc(rm)}</h3><p class="muted">Tasks assigned, completed, or updated during this month, grouped by date</p></div></div>
    ${selected.tasks.length ? `<div class="report-task-list">${groupTasksByDate(selected.tasks).map(([date, dayTasks]) => `<section class="report-day-group"><div class="task-date-heading"><h3>${esc(fullDate(date))}</h3><span>${dayTasks.length} task${dayTasks.length === 1 ? "" : "s"}</span></div>${dayTasks.map(task => `<details class="report-task">
      <summary><span><strong>${esc(task.title)}</strong><small>${esc(task.assignmentType || "Task")} · ${esc(task.priority || "Medium")} priority · Assigned ${esc(task.assignedDate || "date not recorded")}</small></span><span class="tag ${tagClass(task.status)}">${esc(task.status || "Pending")}</span></summary>
      <div class="report-task-body"><p>${esc(task.description || "No description")}</p><div class="report-task-facts"><span>Assigned by <b>${esc(task.assignedByName || "—")}</b></span><span>Assigned date <b>${esc(task.assignedDate || "—")}</b></span><span>Deadline <b>${esc(task.quickDeadlineAt ? fmtTaskDeadline(task) : task.deadline || "—")}</b></span><span>Completed date <b>${esc(task.completedDate || "—")}</b></span><span>Rating <b>${esc(task.rating || "—")}</b></span><span>Review <b>${esc(task.reviewStatus || "—")}</b></span></div>
      ${task.pendingReason ? `<p><b>Pending reason:</b> ${esc(task.pendingReason)}</p>` : ""}${task.reviewRemarks ? `<p><b>Review remarks:</b> ${esc(task.reviewRemarks)}</p>` : ""}
      <h4>Task history (${(task.history || []).length})</h4>${task.history?.length ? `<ol class="report-history">${task.history.map(item => `<li><b>${esc(item.action)}</b> · ${esc(item.by)} · ${stamp(item.at)}${item.remarks ? `<small>${esc(item.remarks)}</small>` : ""}</li>`).join("")}</ol>` : `<p class="muted">No task activity recorded.</p>`}
      </div></details>`).join("")}</section>`).join("")}</div>` : `<div class="empty-state"><strong>No tasks found for this month.</strong></div>`}</article>` : `<div class="panel report-detail-empty"><strong>Select a staff card</strong><p class="muted">View monthly task detail and full activity history, or download a structured report.</p></div>`;
  const printPeople = me.role === "admin" && !selected ? people : selected ? [selected] : [];
  const printReport = printReportMarkup(printPeople);
  return `<article class="panel reports-overview"><div class="panel-heading"><div><p class="eyebrow">PERFORMANCE OVERVIEW</p><h3>Monthly report — ${esc(rm)}</h3><p class="muted">A clear view of work completed and in progress this month.</p></div><div class="tools"><input type="month" id="rm" value="${rm}">
    ${me.role === "admin" ? `<button class="ghost" data-act="repxlsx">⤓ Monthly Excel · all staff</button>` : `<button class="ghost" data-act="repxlsx" data-id="${esc(me.uid)}">⤓ Monthly Excel · my tasks</button>`}<button class="ghost" data-act="print">🖨 ${me.role === "admin" && !selected ? "Monthly PDF · all staff" : "Monthly PDF · selected staff"}</button></div></div>
    <div class="report-summary-grid"><article class="report-summary-card"><span>Tasks tracked</span><strong>${allTasks.length}</strong><small>Assigned, completed, or updated</small></article><article class="report-summary-card is-complete"><span>Completed this month</span><strong>${completedThisMonth}</strong><small>Submitted or approved work</small></article><article class="report-summary-card is-open"><span>Still in progress</span><strong>${openTasks}</strong><small>Pending, active, or corrections</small></article>${me.role === "admin" ? `<article class="report-summary-card is-team"><span>Staff included</span><strong>${reportingStaff}</strong><small>Active or reporting this month</small></article>` : ""}</div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr>${Object.keys(rows[0]).map(k => `<th>${k}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${Object.values(r).map(v => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<p class="muted empty">No tasks assigned this month.</p>`}
    ${me.role === "admin" ? `<div class="report-section-heading"><div><h3>Staff and admin reports</h3><p class="muted">Select a person to see the date-grouped task details and full history.</p></div></div>${staffCards ? `<div class="report-staff-grid">${staffCards}</div>` : `<div class="empty-state"><strong>No staff profiles found</strong></div>`}` : ""}
  </article>${taskDetails}<section class="print-report">${printReport}</section>`;
}
document.addEventListener("click", event => {
  const staffCard = event.target.closest("[data-report-staff]");
  if (!staffCard) return;
  reportStaffUid = reportStaffUid === staffCard.dataset.reportStaff ? "" : staffCard.dataset.reportStaff;
  render();
});
document.addEventListener("change", e => { if (e.target.id === "rm" && e.target.value) { rm = e.target.value; reportStaffUid = ""; render(); } });
async function repXlsx(staffUid = "") {
  try {
    const people = monthlyStaff();
    if (me.role !== "admin" && staffUid && staffUid !== me.uid) throw new Error("You can download only your own monthly report.");
    const person = staffUid ? people.find(item => item.uid === staffUid) : me.role === "admin" ? null : people[0];
    if (staffUid && !person) throw new Error("The requested monthly report is not available for this account.");
    const list = person ? person.tasks : monthTasks();
    if (!list.length) return toast("No tasks to include in this report.");
    const X = await loadExcel(), wb = X.utils.book_new();
    const orderedTasks = list.slice().sort((a, b) =>
      taskReportDate(a).localeCompare(taskReportDate(b))
      || (a.assignedToName || "").localeCompare(b.assignedToName || "")
      || (a.title || "").localeCompare(b.title || "")
    );
    const detailRows = orderedTasks.map(task => ({ "Report Date": taskReportDay(task), ...taskDetailRows([task])[0] }));
    const historyRows = list.flatMap(task => (task.history || []).map(item => ({
      Date: (item.at || "").slice(0, 10),
      "Employee ID": personForUid(task.assignedTo)?.empId || "",
      Staff: task.assignedToName || "",
      Task: task.title,
      Action: item.action || "",
      By: item.by || "",
      At: (item.at || "").replace("T", " ").slice(0, 19),
      From: item.from || "",
      To: item.to || "",
      Remarks: item.remarks || ""
    })));
    const dailyRows = groupTasksByDate(list).flatMap(([date, dayTasks]) => {
      const byPerson = new Map();
      for (const task of dayTasks) {
        const key = task.assignedTo;
        const row = byPerson.get(key) || { Date: date, "Employee ID": personForUid(key)?.empId || "", Staff: task.assignedToName || "", Tasks: 0, Completed: 0, "Admin assigned": 0, "Self assigned": 0 };
        row.Tasks++;
        if (inReportMonth(task.completedDate) && ["Completed", "Pending Review"].includes(task.status)) row.Completed++;
        if (task.assignmentType === "Self Assigned") row["Self assigned"]++;
        else row["Admin assigned"]++;
        byPerson.set(key, row);
      }
      return [...byPerson.values()];
    });
    const summaryRows = person ? monthRows().filter(row => row.Staff === person.name) : monthRows();
    appendStyledSheet(X, wb, "Summary", summaryRows, [16, 24, 16, 16, 14, 16, 16, 14, 14, 18, 22, 22, 16]);
    appendStyledSheet(X, wb, "Daily Summary", dailyRows, [16, 16, 24, 12, 12, 18, 18]);
    appendStyledSheet(X, wb, "Tasks", detailRows, [16, 16, 14, 22, 32, 48, 22, 18, 12, 20, 16, 16, 16, 38, 12, 18, 38, 38]);
    appendStyledSheet(X, wb, "History", historyRows, [16, 14, 22, 32, 24, 22, 22, 20, 20, 48]);
    const fileName = person
      ? `WorkDesk_${(person.empId || person.name).replace(/[^a-z0-9_-]/gi, "_")}_${rm}.xlsx`
      : `WorkDesk_All_Staff_Report_${rm}.xlsx`;
    X.writeFile(wb, fileName);
    toast("Monthly task report downloaded");
  } catch (err) { banner("Report export failed: " + err.message); }
}

function printStaffReport(staffUid) {
  const person = monthlyStaff().find(item => item.uid === staffUid);
  if (!person || (me.role !== "admin" && person.uid !== me.uid)) {
    banner("That staff report is not available for this account.");
    return;
  }
  const printArea = document.querySelector(".print-report");
  if (!printArea) {
    banner("Could not prepare the staff PDF report.");
    return;
  }
  printArea.innerHTML = printReportMarkup([person]);
  window.print();
}

function printCurrentReport() {
  const people = monthlyStaff();
  const selected = me.role === "admin"
    ? people.find(person => person.uid === reportStaffUid)
    : people.find(person => person.uid === me.uid);
  const printPeople = me.role === "admin" && !selected ? people : selected ? [selected] : [];
  const printArea = document.querySelector(".print-report");
  if (!printArea) {
    banner("Could not prepare the monthly PDF report.");
    return;
  }
  printArea.innerHTML = printReportMarkup(printPeople);
  window.print();
}

function printReportMarkup(people) {
  let pageNumber = 0;
  const pages = people.flatMap(person => {
    const datedTasks = groupTasksByDate(person.tasks).flatMap(([date, items]) => items.map(task => ({ date, task })));
    if (!datedTasks.length) return [{ person, datedTasks: [], pageNumber: ++pageNumber }];
    const chunks = [];
    for (let index = 0; index < datedTasks.length; index += 8) chunks.push(datedTasks.slice(index, index + 8));
    const firstPage = pageNumber + 1;
    pageNumber += chunks.length;
    return chunks.map((items, index) => ({ person, datedTasks: items, pageNumber: firstPage + index }));
  });
  if (!pages.length) return `<header class="print-header"><p>VINAYAGA ASSOCIATES · WORKDESK</p><h1>Monthly Task Report</h1><p>${esc(rm)} · Generated ${esc(today())}</p></header><p>No tasks recorded for this month.</p>`;
  return pages.map(({ person, datedTasks, pageNumber: currentPage }) => {
    const dayGroups = new Map();
    for (const item of datedTasks) {
      if (!dayGroups.has(item.date)) dayGroups.set(item.date, []);
      dayGroups.get(item.date).push(item.task);
    }
    const completed = person.tasks.filter(task => inReportMonth(task.completedDate) && ["Completed", "Pending Review"].includes(task.status)).length;
    const taskRows = [...dayGroups.entries()].map(([date, items]) => `<section class="print-day">
      <h3>${esc(fullDate(date))}</h3>
      <ul>${items.map(task => `<li class="print-task-row"><span class="print-task-title">${esc(task.title || "Untitled task")}</span><span class="print-task-type">${task.assignmentType === "Self Assigned" ? "Self" : "Admin"}</span><span class="print-task-status">${esc(task.status || "Pending")}</span>${task.quickDeadlineAt ? `<small>Due ${esc(fmtTaskDeadline(task))}</small>` : task.deadline ? `<small>Due ${esc(task.deadline)}</small>` : ""}</li>`).join("")}</ul>
    </section>`).join("");
    return `<article class="print-page">
      <header class="print-header"><div><p>VINAYAGA ASSOCIATES · WORKDESK</p><h1>Monthly Task Report</h1><strong>${esc(person.name)} · ${esc(person.role === "admin" ? "Administrator" : person.empId || "Staff")}</strong><p>${esc(rm)} · Generated ${esc(today())}</p></div><span class="print-page-number">${currentPage} / ${pages.length}</span></header>
      <div class="print-summary-strip"><span><b>${person.tasks.length}</b> tasks tracked this month</span><span><b>${completed}</b> completed this month</span><span><b>${datedTasks.length}</b> tasks on this page</span></div>
      ${taskRows || `<p>No tasks recorded for this month.</p>`}
    </article>`;
  }).join("");
}

/* ---------- NOTIFICATIONS ---------- */
const seenKey = () => "wd_seen_" + me.uid;
const notificationReadKey = () => "wd_read_notifications_" + me.uid;
const events = () => tasks.flatMap(task => (task.history || [])
  .map((item, index) => ({ ...item, id: `${task.id}|${index}|${item.at || ""}|${item.action || ""}`, title: task.title }))
  .filter(item => item.byId !== me.uid)
).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
function readNotificationIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(notificationReadKey()) || "[]");
    return new Set(Array.isArray(stored) ? stored.filter(id => typeof id === "string") : []);
  } catch (error) {
    console.warn("Could not read notification status:", error);
    return new Set();
  }
}
function notificationIsRead(item, readIds) {
  if (readIds.has(item.id)) return true;
  try {
    const seenAt = Number(localStorage.getItem(seenKey())) || 0;
    return Number.isFinite(Date.parse(item.at || "")) && Date.parse(item.at) <= seenAt;
  } catch (error) {
    console.warn("Could not read notification timestamp:", error);
    return false;
  }
}
function unreadEvents() {
  const readIds = readNotificationIds();
  return events().filter(item => !notificationIsRead(item, readIds));
}
function saveReadNotificationIds(readIds) {
  try { localStorage.setItem(notificationReadKey(), JSON.stringify([...readIds])); }
  catch (error) {
    banner("Could not save notification read status: " + error.message);
    throw error;
  }
}
function bell() {
  if (!me) return;
  const n = unreadEvents().length;
  $("bellN").textContent = n; $("bellN").classList.toggle("hidden", !n);
}
function notificationDialog() {
  const unread = unreadEvents();
  const list = unread.slice(0, 50);
  const body = list.length ? `<p class="muted notification-count">${unread.length} unread notification${unread.length === 1 ? "" : "s"}</p><ul class="notes">${list.map(item => `<li class="new"><div class="notification-copy"><b>${esc(item.action)}</b> — ${esc(item.title)}<small class="muted">${esc(item.by)} · ${stamp(item.at)}${item.remarks ? " · " + esc(item.remarks) : ""}</small></div><button type="button" class="mini notification-read" data-act="readnotification" data-id="${esc(item.id)}">Mark as read</button></li>`).join("")}</ul>${unread.length > list.length ? `<p class="muted">Showing the latest 50. Use “Mark all read” to clear the rest too.</p>` : ""}` : `<p class="muted">You're all caught up.</p>`;
  openDlg("Notifications", body, async () => {
    const readIds = readNotificationIds();
    for (const item of unread) readIds.add(item.id);
    saveReadNotificationIds(readIds);
    bell();
  }, "All unread notifications marked as read", unread.length ? "Mark all read" : "Close");
}
function markNotificationRead(id) {
  if (!id) return;
  const readIds = readNotificationIds();
  readIds.add(id);
  saveReadNotificationIds(readIds);
  bell();
  $("dlg").close();
  notificationDialog();
}
$("bell").addEventListener("click", notificationDialog);

/* ---------- 15-MINUTE TIMER ---------- */
const nudged = {};
setInterval(() => {
  if (!me) return;
  const act = mine().filter(t => t.status === "In Progress" && t.startedAt);
  let chip = $("timer");
  if (!chip) { chip = document.createElement("div"); chip.id = "timer"; document.body.appendChild(chip); }
  chip.classList.toggle("hidden", !act.length);
  chip.innerHTML = act.map(t => {
    const m = Math.floor((Date.now() - Date.parse(t.startedAt)) / 60000), k = Math.floor(m / 15), key = t.id + t.startedAt;
    if (nudged[key] === undefined) nudged[key] = k;
    else if (k > nudged[key]) { nudged[key] = k; toast(`⏱ ${m} min on "${t.title}" — still working?`); }
    return `⏱ ${esc(t.title)} <b>${Math.floor(m / 60)}h ${m % 60}m</b>`;
  }).join("<br>");
}, 15000);
