import { firebaseConfig } from "./firebase-config.js";

const CDN = "https://www.gstatic.com/firebasejs/10.14.1/";
const [{ getApps, initializeApp }, { getAuth, onAuthStateChanged }, { getFirestore, doc, getDoc, updateDoc, deleteField }] = await Promise.all([
  import(CDN + "firebase-app.js"), import(CDN + "firebase-auth.js"), import(CDN + "firebase-firestore.js")
]);
let tries = 0;
while (!getApps().length && tries++ < 100) await new Promise(resolve => setTimeout(resolve, 25));
const app = getApps()[0] || initializeApp(firebaseConfig);
const auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let profile = null;

onAuthStateChanged(auth, async user => {
  profile = null;
  if (!user) return;
  try {
    const snapshot = await getDoc(doc(db, "users", user.uid));
    if (snapshot.exists()) {
      profile = { uid: user.uid, ...snapshot.data() };
    }
  } catch (error) { console.error("Could not load staff management profile:", error); }
});

async function loadAdministratorProfile() {
  const user = auth.currentUser;
  if (!user) return null;
  const snapshot = await getDoc(doc(db, "users", user.uid));
  profile = snapshot.exists() ? { uid: user.uid, ...snapshot.data() } : null;
  return profile?.role === "admin" && profile.active !== false ? profile : null;
}

const sidebar = $("sidebar"), menuButton = $("menuBtn");
$("dlg")?.addEventListener("close", () => $("dlgBody").querySelectorAll('input[type="password"]').forEach(input => { input.value = ""; }));
function mobile() { return matchMedia("(max-width: 720px)").matches; }
function setSidebar(open) {
  if (!sidebar) return;
  if (mobile()) {
    sidebar.classList.toggle("open", open);
    document.body.classList.toggle("sidebar-open", open);
  } else {
    document.body.classList.toggle("sidebar-collapsed", !open);
    sidebar.classList.toggle("open", open);
  }
  menuButton?.setAttribute("aria-expanded", String(open));
  menuButton?.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}
$("sidebarClose")?.addEventListener("click", () => setSidebar(false));
document.addEventListener("click", event => {
  if (mobile() && document.body.classList.contains("sidebar-open") && event.target === document.body) setSidebar(false);
  const nav = event.target.closest("#navigation .nav-link");
  if (mobile() && nav) setSidebar(false);
}, true);
window.addEventListener("resize", () => {
  if (mobile()) {
    document.body.classList.remove("sidebar-collapsed");
    const open = !!sidebar?.classList.contains("open");
    document.body.classList.toggle("sidebar-open", open);
    menuButton?.setAttribute("aria-expanded", String(open));
    menuButton?.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  else {
    document.body.classList.remove("sidebar-open");
    sidebar?.classList.remove("open");
    const open = !document.body.classList.contains("sidebar-collapsed");
    menuButton?.setAttribute("aria-expanded", String(open));
    menuButton?.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
});

document.addEventListener("click", async event => {
  const editButton = event.target.closest('#view button[data-act="edit"][data-id]');
  if (editButton && $("pageTitle")?.textContent === "Staff Management") {
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      if (!await loadAdministratorProfile()) return;
    } catch (error) {
      showBanner("Could not verify administrator access: " + error.message);
      return;
    }
    openAccountEditor(editButton.dataset.id);
    return;
  }
}, true);

async function openAccountEditor(uid) {
  const dialog = $("dlg"), form = $("dlgForm");
  if (!dialog || !form || !profile || profile.role !== "admin") return;
  const isSelf = uid === profile.uid;
  let target = isSelf ? profile : null;
  if (!target) {
    // The staff row itself is the current rendered profile data; refresh it from Firestore.
    try {
      const snapshot = await getDoc(doc(db, "users", uid));
      if (snapshot.exists()) target = { uid, ...snapshot.data() };
    } catch (error) { showBanner("Could not load the staff profile: " + error.message); return; }
  }
  if (!target || (!isSelf && target.role !== "staff")) return;
  $("dlgTitle").textContent = isSelf ? "Edit administrator profile" : `Edit ${target.empId || "staff profile"}`;
  $("dlgBody").innerHTML = `<label>Full name *</label><input name="name" value="${esc(target.name)}" required>
    <label>Username *</label><input name="username" value="${esc(target.username)}" autocomplete="username" required>
    <label>Mobile</label><input name="mobile" inputmode="tel" value="${esc(target.mobile || "")}">
    <label>Joining date</label><input name="joining" type="date" value="${esc(target.joiningDate || "")}">
    ${target.role === "staff" ? `<label class="check-field"><input name="accountTaskAccess" type="checkbox" ${target.accountTaskAccess === true ? "checked" : ""}><span>Allow this staff member to create shop-account tasks</span></label>` : ""}`;
  $("dlgErr").textContent = "";
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.textContent = "Save account";
  const readAccountForm = () => {
    const data = new FormData(form), name = String(data.get("name") || "").trim();
    const username = String(data.get("username") || "").trim().toLowerCase();
    if (!name || name.length > 120) throw new Error("Name is required and must be 120 characters or fewer.");
    if (!/^[a-z0-9._-]{3,}$/.test(username)) throw new Error("Username must be at least 3 letters/numbers, with no spaces.");
    const mobile = String(data.get("mobile") || "").trim();
    const joiningDate = String(data.get("joining") || target.joiningDate || "");
    if (mobile.length > 40 || joiningDate.length > 20) throw new Error("Mobile or joining date is too long.");
    const updates = {
      name, username, mobile, joiningDate, updatedAt: new Date().toISOString(),
      ...(target.role === "staff" ? { accountTaskAccess: data.get("accountTaskAccess") === "on" } : {})
    };
    if (Object.prototype.hasOwnProperty.call(target, "email")) updates.email = deleteField();
    return updates;
  };
  form.onsubmit = async submitEvent => {
    submitEvent.preventDefault();
    submitButton.disabled = true;
    $("dlgErr").textContent = "";
    try {
      await updateDoc(doc(db, "users", uid), readAccountForm());
      dialog.close();
      showToast(isSelf ? "Administrator profile updated" : "Staff account updated");
      if (isSelf) setTimeout(() => location.reload(), 700);
    } catch (error) {
      showError(error.code === "permission-denied"
        ? "Could not save staff details. Publish the updated Firestore rules, then try again."
        : "Could not save staff details: " + error.message);
    } finally {
      submitButton.disabled = false;
    }
  };
  dialog.showModal(); $("dlgBody").querySelector("input")?.focus();
}

function showError(message) { const error = $("dlgErr"); if (error) error.textContent = message; }
function showToast(message) {
  let toast = $("toast");
  if (!toast) { toast = document.createElement("div"); toast.id = "toast"; document.body.append(toast); }
  toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2800);
}
function showBanner(message) { const banner = $("banner"); if (banner) { banner.textContent = message; banner.classList.remove("hidden"); } }
