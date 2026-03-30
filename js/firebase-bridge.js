// ═══════════════════════════════════════════════════════════════════════
//  LIFTMATCH PRO — Firebase Configuration
//  ⚠️  FILL IN YOUR VALUES from Firebase Console → Project Settings → Web App
// ═══════════════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDBx87xAO_bHTwOUyRZb4y0yqt0oVS842g",
  authDomain:        "liftmatchpro-e3c7b.firebaseapp.com",
  projectId:         "liftmatchpro-e3c7b",
  storageBucket:     "liftmatchpro-e3c7b.firebasestorage.app",
  messagingSenderId: "878537495832",
  appId:             "1:878537495832:web:00d7412686cba29bfcfa6d",
  measurementId:     "G-CQGLKPNKWL"
};

// Initialise Firebase
firebase.initializeApp(FIREBASE_CONFIG);
const _fbAuth = firebase.auth();
const _fbDb   = firebase.firestore();

// ── Firebase Bridge: Firestore-backed account field storage ──────────
// Replaces all localStorage _acctKey / loadAccountField / saveDetailsField calls.
// All user profile data now lives in Firestore → users/{uid} and rental_profiles/{uid}

var _userProfileCache = {};  // in-memory cache so UI reads stay snappy

async function _fbSaveUserProfile(uid, data) {
  try {
    await _fbDb.collection('users').doc(uid).set(data, { merge: true });
    _userProfileCache[uid] = { ..._userProfileCache[uid], ...data };
  } catch(e) { console.warn('Profile save failed:', e.message); }
}

async function _fbLoadUserProfile(uid) {
  if (_userProfileCache[uid]) return _userProfileCache[uid];
  try {
    const snap = await _fbDb.collection('users').doc(uid).get();
    if (snap.exists) { _userProfileCache[uid] = snap.data(); return snap.data(); }
  } catch(e) { console.warn('Profile load failed:', e.message); }
  return {};
}

async function _fbSaveRentalProfile(uid, data) {
  try {
    await _fbDb.collection('rental_profiles').doc(uid).set(data, { merge: true });
  } catch(e) { console.warn('Rental profile save failed:', e.message); }
}

async function _fbLoadRentalProfile(uid) {
  try {
    const snap = await _fbDb.collection('rental_profiles').doc(uid).get();
    return snap.exists ? snap.data() : null;
  } catch(e) { console.warn('Rental profile load failed:', e.message); return null; }
}

// Compat shim — loadAccountField now reads from Firestore profile cache
// (synchronous reads use cache; async refresh happens on login)
function loadAccountField(email, field) {
  if (!currentUser || !currentUser.uid) return '';
  const profile = _userProfileCache[currentUser.uid] || {};
  // Map old localStorage field names to Firestore profile fields
  const fieldMap = {
    name: 'fullName', company: 'companyName', abn: 'abn', mobile: 'phone',
    address: 'address', suburb: 'suburb', city: 'city', state: 'state',
    serviceRadiusKm: 'serviceRadiusKm', baseCity: 'city', sectors: '_sectorsJson',
    ruralOptIn: '_ruralOptIn', ruralRadiusKm: 'ruralRadiusKm',
    approvalStatus: 'approvalStatus', pass: ''
  };
  const key = fieldMap[field] !== undefined ? fieldMap[field] : field;
  if (!key) return '';
  if (key === '_sectorsJson') return JSON.stringify(profile.sectors || []);
  if (key === '_ruralOptIn') return profile.ruralOptIn ? '1' : '0';
  return String(profile[key] || '');
}

// Compat shim — saveDetailsField now writes to Firestore
function saveDetailsField(field) {
  if (!currentUser || !currentUser.uid) return;
  const inp = document.getElementById('det-' + field + '-input');
  if (!inp) return;
  const val = inp ? inp.value.trim() : '';
  const fieldMap = {
    name: 'fullName', company: 'companyName', mobile: 'phone',
    address: 'address', suburb: 'suburb', city: 'city', state: 'state'
  };
  const fsField = fieldMap[field] || field;
  _fbSaveUserProfile(currentUser.uid, { [fsField]: val });
  if (['address','suburb','city','state','mobile'].includes(field) && currentUser.role === 'rental') {
    _fbSaveRentalProfile(currentUser.uid, { [fsField]: val });
  }
  showToast('Saved ✓', '#16A34A');
}

// ── Load RENTAL_COMPANIES from Firestore into in-memory array on boot ──
async function _loadRentalCompaniesFromFirestore() {
  try {
    const snap = await _fbDb.collection('rental_profiles').where('active','==',true).get();
    snap.forEach(doc => {
      const d = doc.data();
      const entry = {
        id: doc.id, name: d.companyName, email: d.email,
        phone: d.phone || '', address: d.address || '',
        baseCity: d.city || '', serviceRadiusKm: d.serviceRadiusKm || 75,
        cities: [d.city || ''], machines: (d.sectors||[]).join(', '),
        sectors: d.sectors || [], active: true,
        ruralOptIn: d.ruralOptIn || false, ruralRadiusKm: d.ruralRadiusKm || 0
      };
      const existIdx = RENTAL_COMPANIES.findIndex(c => c.email === d.email);
      if (existIdx > -1) RENTAL_COMPANIES[existIdx] = { ...RENTAL_COMPANIES[existIdx], ...entry };
      else RENTAL_COMPANIES.push(entry);
    });
    console.log(`Loaded ${snap.size} rental companies from Firestore`);
  } catch(e) { console.warn('Could not load rental companies from Firestore:', e.message); }
}

// Kick off rental companies load after full page load (waits for RENTAL_COMPANIES to be defined)
window.addEventListener('load', () => {
  if (typeof RENTAL_COMPANIES !== 'undefined') {
    _loadRentalCompaniesFromFirestore();
  } else {
    // Fallback: retry after short delay
    setTimeout(() => {
      if (typeof RENTAL_COMPANIES !== 'undefined') _loadRentalCompaniesFromFirestore();
    }, 2000);
  }
});
