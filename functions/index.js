const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const FUNCTION_OPTIONS = { region: "us-central1" };

function accountError(error, operation, uid) {
  if (error instanceof HttpsError) return error;
  const code = error.code || "unknown";
  if (code === "auth/user-not-found") return new HttpsError("not-found", "Authentication account not found.");
  if (["auth/invalid-password", "auth/weak-password"].includes(code)) {
    return new HttpsError("invalid-argument", "The new password does not meet the Firebase Authentication password requirements.");
  }
  if (code === "auth/insufficient-permission") {
    logger.error("Staff account operation is missing Firebase Admin permissions", { code, operation, uid });
    return new HttpsError("failed-precondition", "Grant the Cloud Functions runtime service account the Firebase Authentication Admin role, then retry.");
  }
  if (code === "permission-denied") {
    logger.error("Staff account operation was denied", { code, operation, uid });
    return new HttpsError("failed-precondition", "The function service account lacks permission for this operation. Check its Firebase Authentication Admin and Firestore access roles.");
  }
  logger.error("Staff account operation failed", { code, operation, uid, message: error.message });
  const action = {
    authorization: "verify administrator access",
    access: "change staff access",
  }[operation] || "complete the staff account operation";
  return new HttpsError("internal", `Could not ${action}.`, { code, operation });
}

async function requireAdministrator(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in as an administrator to continue.");
  const caller = await db.collection("users").doc(request.auth.uid).get();
  if (!caller.exists || caller.data().role !== "admin" || caller.data().active === false) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
}

exports.adminSetStaffActive = onCall(FUNCTION_OPTIONS, async request => {
  await requireAdministrator(request);
  const { uid, active } = request.data || {};
  if (typeof uid !== "string" || !uid || typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "A staff account and active state are required.");
  }
  if (uid === request.auth.uid) throw new HttpsError("failed-precondition", "You cannot deactivate your own account.");
  const targetRef = db.collection("users").doc(uid);
  const targetSnapshot = await targetRef.get();
  if (!targetSnapshot.exists || targetSnapshot.data().role !== "staff") {
    throw new HttpsError("not-found", "Staff profile not found.");
  }
  try {
    await targetRef.update({ active, updatedAt: new Date().toISOString() });
  } catch (error) {
    throw accountError(error, "access", uid);
  }
  return { success: true };
});
