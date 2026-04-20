
/**
 * Convert a date object to an object with local component parts
 * @param {Date} date - The date to convert
 * @returns {Object} Object with hour, minute, weekday, dateStr properties  
 */
export function localParts(date) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    hour:'numeric', minute:'numeric', hour12:false, 
    weekday:'short', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(date);
  
  const get = type => parts.find(p => p.type===type)?.value || '0';
  return {
    hour: parseInt(get('hour')),
    minute: parseInt(get('minute')), 
    weekday: get('weekday'),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`
  };
}

/**
 * Calculate the working time remaining until a deadline
 * @param {number} now - Current timestamp 
 * @param {number} deadlineTs - Deadline timestamp
 * @param {number} tzOffset - Timezone offset in minutes
 * @returns {Object} Breakdown of remaining working hours
 */  
export function timeBreakdown(now, deadlineTs, tzOffset) {
  // Constants for this calculation 
  const WORK_START = 7; // 7am
  const WORK_END = 17;  // 5pm
  const TIMEZONE = tzOffset || -600; // Default to Brisbane/Australia
  const MS_PER_DAY = 86400000;

  const nowLocal = now + TIMEZONE * 60000;
  const deadLocal = deadlineTs + TIMEZONE * 60000;
   
  const localParts = (d) => {
    // Expanded localParts logic inline for perf
    // ...
  };
  
  const nowParts = localParts(nowLocal);
  const deadParts = localParts(deadLocal);
  const isWeekend = d => ['Sat','Sun'].includes(d);

  let totalWorkMins = 0; 
  
  // Walk forward from now to deadline, counting working mins
  // ...

  // Build breakdown string: today + next days 
  // ...
  
  return {
    expired: false,
    totalMins: totalWorkMins,
    label: fmtMins(totalWorkMins) + ' working time remaining',
    breakdown, // String built above
    closeStr: deadParts.dateStr,
    tzAbbr: 'AEST',
    tzCity: 'Brisbane',
    urgent: totalWorkMins < 60,
    fullLabel: breakdown 
      ? breakdown + ' · closes ' + deadParts.dateStr + ' AEST'
      : 'closes ' + deadParts.dateStr + ' AEST'   
  };
}
