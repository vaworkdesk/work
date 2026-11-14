import { firebaseConfig } from "./firebase-config.js";

const CDN = "https://www.gstatic.com/firebasejs/10.14.1/";
const [{ initializeApp, getApps }, { getAuth, onAuthStateChanged }, { getFirestore, collection, doc, getDoc, onSnapshot, addDoc, query, orderBy, limit }] = await Promise.all([
  import(CDN + "firebase-app.js"),
  import(CDN + "firebase-auth.js"),
  import(CDN + "firebase-firestore.js")
]);

const app = getApps().find(item => item.name === "[DEFAULT]") || initializeApp(firebaseConfig);
const auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id);
const safe = value => String(value ?? "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const day = () => { const d = new Date(), local = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 10); };
const fmt = value => value ? new Date(value + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const dateTime = value => {
  const time = value?.toDate ? value.toDate() : new Date(value || Date.now());
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const dateLabel = value => {
  const time = value?.toDate ? value.toDate() : new Date(value || Date.now());
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
};

let user = null, profile = null, users = [], tasks = [], messages = [], subscriptions = [], featurePage = "", selectedDay = day();
let selectedChatUid = "", selectedStaffUid = "", chatSearch = "";
let chatSearchTimer = 0;
let messageFeedError = "", contactsFeedError = "", messageSendError = "";

function clearSubscriptions() { subscriptions.forEach(unsubscribe => unsubscribe()); subscriptions = []; }

function syncWorkspaceData(event) {
  const state = event?.detail || window.workdeskState || {};
  if (Array.isArray(state.users)) users = state.users;
  if (Array.isArray(state.tasks)) tasks = state.tasks;
  refreshFeature();
}
window.addEventListener("workdesk:data", syncWorkspaceData);

function addNav() {
  const nav = $("navigation");
  if (!nav || $("navTeamLive")) return;
  nav.insertAdjacentHTML("beforeend", '<button class="nav-link admin-only hidden" id="navTeamLive" type="button">◷ <span>Live team board</span></button><button class="nav-link" id="navMessages" type="button">✉ <span>Message centre</span><b class="badge hidden" id="messageBadge"></b></button>');
  $("navTeamLive").addEventListener("click", event => { event.stopPropagation(); showFeature("team"); });
  $("navMessages").addEventListener("click", event => { event.stopPropagation(); showFeature("messages"); });
  nav.addEventListener("click", event => {
    const button = event.target.closest(".nav-link");
    if (button && button.id !== "navTeamLive" && button.id !== "navMessages") {
      featurePage = "";
      window.workdeskFeaturePage = "";
      $("navTeamLive")?.classList.remove("active");
      $("navMessages")?.classList.remove("active");
    }
  });

}

function showFeature(page, preserveConversation = false) {
  if (!profile || (page === "team" && profile.role !== "admin")) return;
  const oldThread = preserveConversation ? $("waThread") : null;
  const oldComposer = preserveConversation ? $("waText") : null;
  const oldSearch = preserveConversation ? $("waSearch") : null;
  const wasAtBottom = oldThread && oldThread.scrollHeight - oldThread.scrollTop - oldThread.clientHeight < 48;
  const draft = oldComposer?.value || "";
  const focusedId = [oldComposer, oldSearch].includes(document.activeElement) ? document.activeElement.id : "";
  const selection = focusedId === "waSearch" ? [oldSearch.selectionStart, oldSearch.selectionEnd] : null;
  featurePage = page;
  window.workdeskFeaturePage = page;
  if (page === "messages") {
    markConversationRead(selectedChatUid);
    updateBadge();
  }
  document.querySelectorAll("#navigation .nav-link").forEach(button => button.classList.toggle("active", button.id === (page === "team" ? "navTeamLive" : "navMessages")));
  $("pageTitle").textContent = page === "team" ? "Live team board" : "Message centre";
  $("view").innerHTML = page === "team" ? teamBoard() : messageCentre();
  if (page === "messages") {
    const composer = $("waText"), search = $("waSearch"), thread = $("waThread");
    if (composer && draft) composer.value = draft;
    if (composer && draft) composer.style.height = `${Math.min(composer.scrollHeight, 120)}px`;
    if (thread) thread.scrollTop = oldThread && preserveConversation && !wasAtBottom ? oldThread.scrollTop : thread.scrollHeight;
    if (focusedId === "waText") composer?.focus({ preventScroll: true });
    if (focusedId === "waSearch" && search) {
      search.focus({ preventScroll: true });
      if (selection) search.setSelectionRange(...selection);
    }
  }
}

const statusOf = task => task.status || "Pending";

function historyAt(task, date) {
  if ((task.assignedDate || "") > date) return null;
  let latest = null;
  for (const item of task.history || []) {
    if (item.at && item.at.slice(0, 10) <= date && (!latest || item.at >= latest.at)) latest = item;
  }
  return latest ? latest.to || "Pending" : "Pending";
}

const activeTaskStatus = status => ["Pending", "In Progress", "Corrections Requested"].includes(status);
const statusForDay = (task, date) => date === day() ? statusOf(task) : historyAt(task, date);

function teamBoard() {
  const activeStaff = users.filter(person => person.role === "staff" && person.active !== false);
  const dayTasks = tasks.filter(task => (task.assignedDate || "") <= selectedDay);
  const snapshot = dayTasks.map(task => ({ ...task, dayStatus: statusForDay(task, selectedDay) })).filter(task => activeTaskStatus(task.dayStatus));
  const tasksByStaff = new Map();
  for (const task of snapshot) {
    const assigned = tasksByStaff.get(task.assignedTo) || [];
    assigned.push(task);
    tasksByStaff.set(task.assignedTo, assigned);
  }
  const todayTasks = tasks.filter(task => task.assignedDate === selectedDay);
  const carried = snapshot.filter(task => task.assignedDate < selectedDay);
  const doing = snapshot.filter(task => task.dayStatus === "In Progress");
  const pending = snapshot.filter(task => task.dayStatus !== "In Progress");
  const stat = (label, value, note, tone) => `<article class="live-stat ${tone}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
  const rows = activeStaff.map(person => {
    const assigned = tasksByStaff.get(person.uid) || [];
    const current = assigned.filter(task => task.dayStatus === "In Progress");
    const waiting = assigned.filter(task => task.dayStatus !== "In Progress");
    const selected = person.uid === selectedStaffUid;
    return `<button type="button" class="staff-live-card ${selected ? "is-selected" : ""}" data-staff-card="${safe(person.uid)}" aria-pressed="${selected}" aria-label="View ${safe(person.name)}'s tasks">
      <span class="staff-live-heading"><span class="live-avatar">${safe((person.name || "?").slice(0, 1).toUpperCase())}</span><span class="staff-live-copy"><strong>${safe(person.name)}</strong><small>${safe(person.empId || "Staff")}</small></span><span class="live-dot">Live</span></span>
      <span class="staff-live-counts"><span><b>${current.length}</b> in progress</span><span><b>${waiting.length}</b> pending / corrections</span></span>
      <span class="staff-card-hint">${selected ? "Selected · task details below" : "Select to view task details"} <span aria-hidden="true">→</span></span>
    </button>`;
  }).join("");
  const label = selectedDay === day() ? "Today" : fmt(selectedDay);
  const selectedStaff = activeStaff.find(person => person.uid === selectedStaffUid);
  const selectedTasks = selectedStaff ? tasksByStaff.get(selectedStaff.uid) || [] : [];
  const taskRows = selectedTasks.map(task => {
    const stage = task.accountStages?.[task.currentStage];
    const stageSummary = task.accountTask
      ? `<small>${safe(task.shopName || "Shop account")} · ${stage ? `Stage ${task.currentStage + 1}/${task.accountStages.length}: ${safe(stage.name)} · ${safe(stage.status || "Pending")}` : "All stages complete"}</small>`
      : "";
    return `<li><span class="live-status ${task.dayStatus === "In Progress" ? "is-progress" : "is-pending"}"></span><span class="staff-task-copy"><strong>${safe(task.title)}</strong>${stageSummary}${task.description ? `<small>${safe(task.description)}</small>` : ""}${task.assignedDate < selectedDay ? `<small class="carry-label">Carried forward · ${fmt(task.assignedDate)}</small>` : ""}</span><span class="tag ${task.dayStatus === "In Progress" ? "progress" : task.dayStatus === "Corrections Requested" ? "corr" : "pending"}">${safe(task.dayStatus)}</span></li>`;
  }).join("");
  const detail = selectedStaff ? `<section class="panel staff-task-detail" aria-live="polite"><div class="panel-heading"><div><p class="eyebrow">DAILY WORK UPDATE</p><h3>${safe(selectedStaff.name)} · ${safe(label)}</h3><p class="muted">${selectedTasks.filter(task => task.dayStatus === "In Progress").length} in progress · ${selectedTasks.length - selectedTasks.filter(task => task.dayStatus === "In Progress").length} pending / corrections</p></div></div>${selectedTasks.length ? `<ul class="live-task-list detail-task-list">${taskRows}</ul>` : `<div class="empty-state"><strong>No current or pending tasks</strong><p class="muted">There is no active work recorded for this staff member on this date.</p></div>`}</section>` : `<section class="panel staff-task-detail staff-detail-empty"><strong>Select a staff card to see their daily update</strong><p class="muted">Only pending and in-progress tasks for the selected date are shown.</p></section>`;
  return `<div class="teamboard-page"><div class="live-intro"><div><p class="eyebrow">REAL-TIME OVERVIEW</p><h2>${safe(label)} daily update</h2><p class="muted">Select a date to see current progress, pending work, and unfinished tasks carried forward. Completed work is hidden.</p></div><span class="live-indicator"><i></i> Live updates on</span></div><div class="panel analytics-controls"><label for="analyticsDay">Dashboard date</label><input id="analyticsDay" type="date" max="${day()}" value="${safe(selectedDay)}"><span class="muted">Earlier dates use task history; today uses the latest task status.</span></div><div class="live-stat-grid">${stat("Assigned", todayTasks.length, "Tasks assigned on " + safe(label), "is-assigned")}${stat("In progress", doing.length, "Active work on " + safe(label), "is-progress")}${stat("Pending / corrections", pending.length, carried.length + " carried from earlier days", "is-pending")}</div><div class="live-section-heading"><div><h3>Staff daily updates · ${safe(label)}</h3><p class="muted">Select a staff card for their pending and in-progress tasks</p></div><span class="muted">${activeStaff.length} active staff</span></div><div class="staff-live-grid">${rows || '<div class="panel empty-state">No active staff members yet.</div>'}</div>${detail}</div>`;
}

const messageTime = message => message.createdAt?.toDate
  ? message.createdAt.toDate().getTime()
  : Date.parse(message.createdAt || "") || 0;
const readKey = contactUid => `wd_message_read_${user?.uid}_${contactUid}`;

function readTimestamp(contactUid) {
  try { return Number(localStorage.getItem(readKey(contactUid))) || 0; }
  catch { return 0; }
}

function markConversationRead(contactUid) {
  if (!contactUid || !user) return;
  const latest = messages.reduce((time, message) => {
    const belongsToConversation = contactUid === "all"
      ? message.to === "all" && message.from !== user.uid
      : message.from === contactUid && message.to === user.uid;
    return belongsToConversation ? Math.max(time, messageTime(message)) : time;
  }, 0);
  if (!latest || latest <= readTimestamp(contactUid)) return;
  try { localStorage.setItem(readKey(contactUid), String(latest)); }
  catch (error) { console.warn("Could not save message read state:", error); }
}

function contactMatches(person) {
  const term = chatSearch.trim().toLowerCase();
  if (!term) return true;
  return `${person.name || ""} ${person.empId || ""}`.toLowerCase().includes(term);
}

function selectedContact() {
  if (selectedChatUid === "all") return { uid: "all", name: "All staff", role: "group", empId: "Workspace group" };
  return users.find(person => person.uid === selectedChatUid) || null;
}

function renderContacts() {
  const summaries = new Map(), readTimes = new Map();
  for (const message of messages) {
    let contactUid = "";
    if (message.to === "all") contactUid = "all";
    else if (message.from === user.uid) contactUid = message.to;
    else if (message.to === user.uid) contactUid = message.from;
    if (!contactUid) continue;
    const summary = summaries.get(contactUid) || { recent: null, unread: 0 };
    if (!summary.recent || messageTime(message) > messageTime(summary.recent)) summary.recent = message;
    const incoming = contactUid === "all"
      ? message.to === "all" && message.from !== user.uid
      : message.from === contactUid && message.to === user.uid;
    if (incoming) {
      if (!readTimes.has(contactUid)) readTimes.set(contactUid, readTimestamp(contactUid));
      if (messageTime(message) > readTimes.get(contactUid)) summary.unread++;
    }
    summaries.set(contactUid, summary);
  }
  const people = users.filter(person => person.active !== false && person.uid !== user.uid);
  const groupSummary = summaries.get("all") || { recent: null, unread: 0 };
  const groupItem = `<button type="button" class="wa-contact wa-group-contact ${selectedChatUid === "all" ? "selected" : ""}" data-chat-contact="all">
      <span class="wa-avatar group-avatar" aria-hidden="true">◎</span>
      <span class="wa-contact-copy"><strong>All staff</strong><small>${safe(groupSummary.recent?.text || "Message everyone in the workspace")}</small></span>
      <span class="wa-contact-meta">${groupSummary.recent ? `<small>${safe(dateTime(groupSummary.recent.createdAt))}</small>` : ""}${groupSummary.unread ? `<b class="wa-unread">${groupSummary.unread > 99 ? "99+" : groupSummary.unread}</b>` : ""}</span>
    </button>`;
  const matching = people.filter(contactMatches).map(person => {
    const summary = summaries.get(person.uid) || { recent: null, unread: 0 };
    const recent = summary.recent, unread = summary.unread;
    const initials = safe((person.name || "?").slice(0, 1).toUpperCase());
    return `<button type="button" class="wa-contact ${person.uid === selectedChatUid ? "selected" : ""}" data-chat-contact="${safe(person.uid)}">
      <span class="wa-avatar">${initials}</span>
      <span class="wa-contact-copy">
        <strong>${safe(person.name || "Employee")}</strong>
        <small>${safe(recent?.text || (person.role === "admin" ? "Administrator" : person.empId || "Staff"))}</small>
      </span>
      <span class="wa-contact-meta">${recent ? `<small>${safe(dateTime(recent.createdAt))}</small>` : ""}${unread ? `<b class="wa-unread">${unread > 99 ? "99+" : unread}</b>` : ""}</span>
    </button>`;
  });
  return groupItem + matching.join("");
}

function visibleMessages() {
  if (!selectedChatUid) return [];
  return messages.filter(message =>
    selectedChatUid === "all"
      ? message.to === "all"
      : (message.from === user.uid && message.to === selectedChatUid) ||
        (message.from === selectedChatUid && message.to === user.uid)
  ).sort((a, b) => {
    const aTime = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : Date.parse(a.createdAt || "") || 0;
    const bTime = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : Date.parse(b.createdAt || "") || 0;
    return aTime - bTime;
  });
}

function messageCentre() {
  const conversation = visibleMessages();
  const thread = conversation.length ? conversation.map((item, index) => {
    const previous = conversation[index - 1];
    const date = dateLabel(item.createdAt);
    const showDate = !previous || dateLabel(previous.createdAt) !== date;
    const outgoing = item.from === user.uid;
    const author = selectedChatUid === "all" && !outgoing ? `<strong class="wa-author">${safe(item.fromName || "Staff member")}</strong>` : "";
    return `${showDate ? `<div class="wa-date"><span>${safe(date || "Today")}</span></div>` : ""}<div class="wa-message-row ${outgoing ? "outgoing" : "incoming"}"><article class="wa-bubble">${author}<p>${safe(item.text).replace(/\n/g, "<br>")}</p><time>${safe(dateTime(item.createdAt))}</time></article></div>`;
  }).join("") : `<div class="wa-empty-chat"><span>✉</span><strong>Start a conversation</strong><p>Select a staff member to send your first message.</p></div>`;

  const contact = selectedContact();
  return `<div class="wa-shell ${contact ? "has-contact" : ""}">
    <aside class="wa-contacts">
      <header class="wa-list-header"><div><p class="eyebrow">WORKSPACE CHAT</p><h2>Messages</h2></div><span class="wa-online-dot" title="Online"></span></header>
      <label class="wa-search"><span aria-hidden="true">⌕</span><input id="waSearch" type="search" placeholder="Search staff" value="${safe(chatSearch)}" aria-label="Search staff"></label>
      <div class="wa-contact-list">${renderContacts()}</div>
    </aside>
    <section class="wa-conversation" aria-label="Conversation panel">
      <p class="wa-live-error" id="messageError" role="alert">${safe(messageFeedError || contactsFeedError)}</p>
      ${contact ? `<header class="wa-chat-header"><button class="wa-back" type="button" data-chat-back aria-label="Back to messages">‹</button><span class="wa-avatar ${contact.role === "group" ? "group-avatar" : ""}">${contact.role === "group" ? "◎" : safe((contact.name || "?").slice(0, 1).toUpperCase())}</span><span><strong>${safe(contact.name)}</strong><small>${safe(contact.role === "group" ? "Group conversation · everyone can read and reply" : contact.role === "admin" ? "Administrator" : contact.empId || "Staff")}</small></span></header>
      <div class="wa-thread" id="waThread" aria-live="polite">${thread}</div>
      <p class="wa-error" id="waError" role="alert">${safe(messageSendError)}</p>
      <form class="wa-composer" id="waComposer"><textarea id="waText" rows="1" maxlength="2000" placeholder="${contact.role === "group" ? "Message all staff" : "Type a message"}" aria-label="${contact.role === "group" ? "Message all staff" : "Type a message"}" required></textarea><button type="submit" aria-label="Send message">➤</button></form>` : `<div class="wa-start"><div class="wa-start-icon">✉</div><h2>WorkDesk messages</h2><p>Select a person to open your chat and send a message.</p></div>`}
    </section>
  </div>`;
}

function subscribe() {
  clearSubscriptions();
  messages = [];
  if (!selectedChatUid) selectedChatUid = "all";
  const sharedState = window.workdeskState || {};
  users = Array.isArray(sharedState.users) ? sharedState.users : [];
  tasks = Array.isArray(sharedState.tasks) ? sharedState.tasks : [];
  if (profile.role !== "admin") {
    subscriptions.push(onSnapshot(collection(db, "users"), snap => {
      users = snap.docs.map(item => ({ uid: item.id, ...item.data() })).filter(person => person.uid === profile.uid || person.active !== false);
      if (!selectedChatUid || (selectedChatUid !== "all" && !users.some(person => person.uid === selectedChatUid))) {
        selectedChatUid = users.find(person => person.uid !== profile.uid)?.uid || "";
      }
      contactsFeedError = "";
      refreshFeature();
    }, error => reportError(error, "contacts")));
  }
  subscriptions.push(onSnapshot(query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(500)), snap => {
    messages = snap.docs.map(item => ({ id: item.id, ...item.data() }));
    messageFeedError = "";
    if (featurePage === "messages") markConversationRead(selectedChatUid);
    refreshFeature();
  }, error => reportError(error, "messages")));
}

function reportError(error, source) {
  const message = `Live ${source === "messages" ? "message feed" : "staff contacts"} error: ${error.message}`;
  if (source === "messages") messageFeedError = message;
  else contactsFeedError = message;
  console.error(message, error);
  if (featurePage === "messages") refreshFeature();
}

function updateBadge() {
  const badge = $("messageBadge");
  if (!badge) return;
  const readTimes = new Map();
  const count = messages.reduce((total, message) => {
    const isGroupUnread = message.to === "all" && message.from !== user?.uid;
    if (message.to !== user?.uid && !isGroupUnread) return total;
    const conversationId = isGroupUnread ? "all" : message.from;
    if (!readTimes.has(conversationId)) readTimes.set(conversationId, readTimestamp(conversationId));
    return total + (messageTime(message) > readTimes.get(conversationId) ? 1 : 0);
  }, 0);
  badge.textContent = count > 99 ? "99+" : count;
  badge.classList.toggle("hidden", !count);
}

function refreshFeature() {
  if (featurePage) showFeature(featurePage, true);
  updateBadge();
}

$("view")?.addEventListener("change", event => {
  if (event.target.id === "analyticsDay" && event.target.value && event.target.value <= day()) {
    selectedDay = event.target.value;
    showFeature("team");
  }
});

$("view")?.addEventListener("input", event => {
  if (event.target.id === "waSearch") {
    chatSearch = event.target.value.trim();
    clearTimeout(chatSearchTimer);
    chatSearchTimer = setTimeout(() => {
      const list = $("view").querySelector(".wa-contact-list");
      if (featurePage === "messages" && list) list.innerHTML = renderContacts();
    }, 100);
  }
  if (event.target.id === "waText") {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
  }
});

$("view")?.addEventListener("click", event => {
  const contact = event.target.closest("[data-chat-contact]");
  if (contact) {
    selectedChatUid = contact.dataset.chatContact;
    markConversationRead(selectedChatUid);
    updateBadge();
    if (featurePage === "messages") showFeature("messages");
    return;
  }
  const staffCard = event.target.closest("[data-staff-card]");
  if (staffCard && featurePage === "team") {
    selectedStaffUid = selectedStaffUid === staffCard.dataset.staffCard ? "" : staffCard.dataset.staffCard;
    showFeature("team");
    return;
  }
  if (event.target.closest("[data-chat-back]")) {
    selectedChatUid = "";
    if (featurePage === "messages") showFeature("messages");
  }
});

$("view")?.addEventListener("submit", async event => {
  if (event.target.id !== "waComposer") return;
  event.preventDefault();
  const textarea = $("waText");
  const button = event.target.querySelector("button[type=submit]");
  const text = textarea.value.trim();
  if (!text || !selectedChatUid || !user || !profile) return;
  button.disabled = true;
  try {
    await addDoc(collection(db, "messages"), { from: user.uid, fromName: profile.name, to: selectedChatUid, text, createdAt: new Date().toISOString() });
    textarea.value = ""; textarea.style.height = "auto"; messageSendError = "";
    const err = $("waError"); if (err) err.textContent = "";
  } catch (exception) {
    messageSendError = exception.code === "permission-denied"
      ? "Message was denied by Firestore. Confirm the latest messaging rules are published and this account is active."
      : `Message could not be sent: ${exception.message}`;
    const err = $("waError"); if (err) err.textContent = messageSendError;
  } finally { button.disabled = false; textarea.focus(); }
});

onAuthStateChanged(auth, async currentUser => {
  clearSubscriptions();
  profile = null; user = currentUser; featurePage = ""; window.workdeskFeaturePage = ""; selectedChatUid = ""; selectedStaffUid = ""; chatSearch = "";
  messages = [];
  messageFeedError = ""; contactsFeedError = ""; messageSendError = "";
  if (!currentUser) {
    $("navTeamLive")?.classList.add("hidden");
    updateBadge();
    return;
  }
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    if (!snap.exists() || snap.data().active === false) return;
    profile = { uid: currentUser.uid, ...snap.data() };
    addNav();
    $("navTeamLive").classList.toggle("hidden", profile.role !== "admin");
    subscribe();
  } catch (error) {
    console.error("Could not initialize live workspace", error);
  }
});

window.addEventListener("load", () => {
  if (featurePage === "messages") showFeature("messages");
});
