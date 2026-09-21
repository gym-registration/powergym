/**
 * checkInSchedule.js
 * ---------------------------------------------------------
 * Validates whether a member is allowed to check in RIGHT NOW
 * based on the schedule attached to their membership plan.
 *
 * Framework-agnostic: plug this into React, Vue, plain JS,
 * or a Node/Express backend route handler.
 * ---------------------------------------------------------
 */

// ---- 1. Example member data shape ----
// Add a `schedule` object to each member record.
// Unlimited plans (Monthly, Yearly) can use days: "any".
// Restricted plans (Half Month, promo passes) list specific days + hours.

const exampleMember = {
  id: 85,
  name: "Joy T. World",
  plan: "Half Month",
  status: "active",
  schedule: {
    days: ["Mon", "Wed", "Fri"],   // or "any"
    timeStart: "06:00",           // 24h format "HH:mm"
    timeEnd: "22:00",
  },
};

// ---- 2. Core validation function ----

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Checks if a member is within their allowed check-in schedule.
 * @param {Object} member - member record with a `schedule` field
 * @param {Date} [now] - optional override for current time (useful for testing)
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function isWithinSchedule(member, now = new Date()) {
  const schedule = member.schedule;

  // No schedule set at all -> treat as unrestricted (fail-open)
  // Flip this to `return { allowed: false, reason: "No schedule configured" }`
  // if you'd rather fail-closed (block until a schedule is set).
  if (!schedule) {
    return { allowed: true, reason: null };
  }

  const todayName = DAY_NAMES[now.getDay()];

  // --- Day check ---
  if (schedule.days !== "any") {
    const allowedDays = Array.isArray(schedule.days) ? schedule.days : [];
    if (!allowedDays.includes(todayName)) {
      return {
        allowed: false,
        reason: `Not scheduled today. Allowed days: ${allowedDays.join(", ")}`,
      };
    }
  }

  // --- Time-of-day check ---
  if (schedule.timeStart && schedule.timeEnd) {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = schedule.timeStart.split(":").map(Number);
    const [endH, endM] = schedule.timeEnd.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
      return {
        allowed: false,
        reason: `Outside allowed hours (${schedule.timeStart} - ${schedule.timeEnd})`,
      };
    }
  }

  return { allowed: true, reason: null };
}

// ---- 3. Example: using it to gate the "CHECK IN" button/action ----

function attemptCheckIn(member, { staffOverride = false } = {}) {
  const check = isWithinSchedule(member);

  if (!check.allowed && !staffOverride) {
    return {
      success: false,
      status: "OUT_OF_SCHEDULE",
      message: check.reason,
    };
  }

  // Passed validation (or staff manually overrode it) -> proceed with normal check-in
  return {
    success: true,
    status: "ACTIVE",
    checkInTime: new Date().toISOString(),
    overridden: !check.allowed && staffOverride,
  };
}

// ---- 4. Quick demo / tests ----

if (require.main === module) {
  console.log("Now:", new Date().toString());
  console.log(attemptCheckIn(exampleMember));

  // Simulate a Tuesday at 3:05 PM (not in Mon/Wed/Fri schedule)
  const tuesday = new Date("2026-09-22T15:05:00");
  console.log(isWithinSchedule(exampleMember, tuesday));

  // Staff override example
  console.log(attemptCheckIn(exampleMember, { staffOverride: true }));
}

module.exports = { isWithinSchedule, attemptCheckIn, DAY_NAMES };
