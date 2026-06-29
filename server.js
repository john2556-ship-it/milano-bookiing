const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors({
  origin: [
    'https://book.milanonailspa529.com',
    'https://ok.milanonailspa529.com',
    'https://booking.milanonailspa529.com',
    'https://milanonailspa529.com',
    'http://milanonailspaelyson.dvrlists.com',
    'http://milanonailspaelyson.dvrlists.com:3456',
    'http://localhost:3456',
    'http://localhost:3000',
    'file://'
  ],
  credentials: true
}));
app.use(express.json());

// ── ATSoft Credentials ──
const ATSOFT_USERNAME = '0000022222';
const ATSOFT_PASSWORD = '0000022222';
const ATSOFT_BASE     = 'https://book.atsoft.com';
const STORE_ID        = 498;

// ── SQL Config (fallback nếu PC bật) ──
const dbConfig = {
  server: '127.0.0.1',
  database: 'DbProvider',
  user: 'sa',
  password: 'atsoft',
  port: 1433,
  options: { enableArithAbort: true, trustServerCertificate: true, encrypt: false }
};
let pool = null;
async function getPool() {
  if (!pool) {
    pool = await sql.connect(dbConfig);
    console.log('✅ Connected to SQL Server!');
  }
  return pool;
}

// ── ATSoft Session ──
let atsoftCookie = null;
let atsoftCookieExpiry = null;

async function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function loginAtsoft() {
  console.log('🔐 Logging into ATSoft...');
  const loginRes = await fetchUrl(
    `${ATSOFT_BASE}/Dashboard/apilogin?username=${ATSOFT_USERNAME}&password=${ATSOFT_PASSWORD}`
  );
  const cookies = loginRes.headers['set-cookie'] || [];
  if (cookies.length > 0) {
    atsoftCookie = cookies.map(c => c.split(';')[0]).join('; ');
    atsoftCookieExpiry = Date.now() + (25 * 60 * 1000);
    console.log('✅ ATSoft login successful!');
    return true;
  }
  console.error('❌ ATSoft login failed - status:', loginRes.status);
  return false;
}

async function getAtsoftCookie() {
  if (!atsoftCookie || Date.now() > atsoftCookieExpiry) {
    await loginAtsoft();
  }
  return atsoftCookie;
}

// ── Scrape Technicians từ ATSoft HTML ──
let techCache = null;
let techCacheExpiry = null;

async function scrapeEmployeesFromHTML() {
  // Cache 10 phút
  if (techCache && Date.now() < techCacheExpiry) {
    console.log('📋 Returning cached technicians');
    return techCache;
  }

  console.log('🔍 Scraping technicians from ATSoft HTML...');
  const res = await fetchUrl(`${ATSOFT_BASE}/Book/${STORE_ID}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });

  const html = res.body;
  const employees = [{ EmployeeID: 0, FullName: 'Anyone', CellPhone: '' }];

  // Parse: techName="HANNAH" type="radio" value="198"
  const regex = /techName="([^"]+)"\s+type="radio"\s+value="(\d+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const name = match[1];
    const id   = parseInt(match[2]);
    if (id > 0) {
      employees.push({ EmployeeID: id, FullName: name, CellPhone: '' });
    }
  }

  console.log(`✅ Found ${employees.length} employees from HTML`);

  // Cache kết quả 10 phút
  techCache = employees;
  techCacheExpiry = Date.now() + (10 * 60 * 1000);

  return employees;
}

// ── Scrape Services từ ATSoft HTML ──
let svcCache = null;
let svcCacheExpiry = null;

async function scrapeServicesFromHTML() {
  if (svcCache && Date.now() < svcCacheExpiry) {
    return svcCache;
  }

  console.log('🔍 Scraping services from ATSoft HTML...');
  const res = await fetchUrl(`${ATSOFT_BASE}/Book/${STORE_ID}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });

  const html = res.body;
  const services = [];

  // Parse service categories
  const catRegex = /data-category-id="(\d+)"[^>]*>([^<]+)</g;
  let match;
  while ((match = catRegex.exec(html)) !== null) {
    services.push({ CategoryID: parseInt(match[1]), CategoryName: match[2].trim() });
  }

  svcCache = services;
  svcCacheExpiry = Date.now() + (10 * 60 * 1000);
  return services;
}

function formatTime12h(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${hour12}:${String(m).padStart(2,'0')} ${ampm}`;
}

async function createAtsoftAppointment(data) {
  const cookie = await getAtsoftCookie();
  const payload = JSON.stringify({
    AppointmentDate:  data.appointmentDate,
    CustomerName:     data.customerName,
    CustomerPhone:    data.customerPhone,
    IsBlockOff:       false,
    SelectedServices: [],
    TechnicianId:     parseInt(data.employeeId) || 1,
    TimeStart:        data.timeStart,
    TimeEnd:          data.timeEnd,
    StoreId:          STORE_ID,
    Notes:            data.notes || ''
  });
  const res = await fetchUrl(`${ATSOFT_BASE}/api/events/create-appointment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookie,
      'Referer': `${ATSOFT_BASE}/Dashboard/Calendar`,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Length': Buffer.byteLength(payload)
    },
    body: payload
  });
  console.log(`📡 ATSoft: ${res.status} - ${res.body}`);
  return { status: res.status, body: res.body };
}

// ── Improved fetchUrl with redirect & cookie support ──────────────
async function fetchUrlFull(url, options = {}, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, redirectsLeft, cookieJar) => {
      const urlObj = new URL(currentUrl);
      const lib = urlObj.protocol === 'https:' ? https : http;
      const reqOptions = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: { ...options.headers }
      };
      if (cookieJar) reqOptions.headers['Cookie'] = cookieJar;
      const req = lib.request(reqOptions, (res) => {
        let data = '';
        
        // 🛠️ FIX: Properly merge cookies (New cookies overwrite old ones)
        const cookieMap = new Map();
        if (cookieJar) {
          cookieJar.split('; ').forEach(c => {
            const parts = c.split('=');
            if (parts.length >= 2) cookieMap.set(parts[0], parts.slice(1).join('='));
          });
        }
        const newCookies = res.headers['set-cookie'] || [];
        newCookies.forEach(c => {
          const primary = c.split(';')[0];
          const parts = primary.split('=');
          if (parts.length >= 2) cookieMap.set(parts[0], parts.slice(1).join('='));
        });
        const allCookies = Array.from(cookieMap.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

        // Follow redirects
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) && redirectsLeft > 0) {
          const location = res.headers['location'];
          if (location) {
            const nextUrl = location.startsWith('http') ? location : `${urlObj.protocol}//${urlObj.hostname}${location}`;
            res.resume();
            doRequest(nextUrl, redirectsLeft - 1, allCookies);
            return;
          }
        }
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, cookies: allCookies }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    };
    doRequest(url, maxRedirects, options.headers ? options.headers['Cookie'] : '');
  });
}

// 🛠️ FIX: Helper to extract hidden ASP.NET tracking state fields
function extractFormState(html) {
  const state = [];
  const regex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const fullTag = match[0].toLowerCase();
    const name = match[1];
    const value = match[2];
    if (fullTag.includes('type="hidden"') || name === '__RequestVerificationToken') {
      if (!state.find(s => s.name === name)) {
        state.push({ name, value });
      }
    }
  }
  return state;
}

// ── Scrape Availability từ ATSoft HTML ──────────────────
async function scrapeAvailabilityFromATSoft(date, employeeId, serviceIds) {
  console.log(`🔍 Scraping availability: date=${date} services=${JSON.stringify(serviceIds)} empId=${employeeId}`);
  try {
    const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15';

    // Step 1: GET /Book/STORE_ID
    const step1 = await fetchUrlFull(`${ATSOFT_BASE}/Book/${STORE_ID}`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
    });
    console.log(`  Step1 status: ${step1.status}`);

    const state1 = extractFormState(step1.body);
    if (state1.length === 0) { console.log('  ❌ No form state found in step1'); return null; }

    const serviceMatch = step1.body.match(/name="SelectedServices"[^>]+value="(\d+)"/);
    const serviceId = serviceMatch ? serviceMatch[1] : '1';
    const empId = parseInt(employeeId) || 0;

    // Build Step 2 Body dynamically 
    const params2 = new URLSearchParams();
    state1.forEach(s => params2.append(s.name, s.value));
    params2.append('SelectedEmployeeLocalID', empId);
    // Always use ATSoft's real service IDs (frontend IDs like 1,2,3 are NOT ATSoft IDs)
    // Scrape all available services from ATSoft HTML and use first one for nofit calculation
    const allSvcMatches = [...step1.body.matchAll(/name="SelectedServices"[^>]+value="(\d+)"/g)];
    if (allSvcMatches.length > 0) {
      // Use first service from ATSoft (gives ATSoft a valid duration for nofit calc)
      params2.append('SelectedServices', allSvcMatches[0][1]);
      console.log(`  Using ATSoft serviceId: ${allSvcMatches[0][1]} (of ${allSvcMatches.length} available)`);
    } else {
      params2.append('SelectedServices', serviceId);
    }

    // Step 2: POST employee + service selection → /Book/Booking2
    const step2 = await fetchUrlFull(`${ATSOFT_BASE}/Book/Booking2`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': step1.cookies,
        'Referer': `${ATSOFT_BASE}/Book/${STORE_ID}`
      },
      body: params2.toString()
    });
    console.log(`  Step2 status: ${step2.status}`);

    const state2 = extractFormState(step2.body);

    // Build Step 3 Body dynamically
    const [y, m, d] = date.split('-');
    const atsoftDate = `${m}/${d}/${y}`;
    const params3 = new URLSearchParams();
    state2.forEach(s => params3.append(s.name, s.value));
    params3.append('SelectedDate', atsoftDate);

    // Step 3: POST date → /Book/Booking3
    const step3 = await fetchUrlFull(`${ATSOFT_BASE}/Book/Booking3`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': step2.cookies,
        'Referer': `${ATSOFT_BASE}/Book/Booking2`
      },
      body: params3.toString()
    });
    console.log(`  Step3 status: ${step3.status}`);

    const html = step3.body;

    // Parse time slots (Primary Regex)
    const slots = [];
    const slotRegex = /<input([^>]*?)timeidx="(\d+)"([^>]*?)>[\s\S]*?<span[^>]*timeidx="\d+"[^>]*>\s*([\d:]+\s*[AP]M)\s*<\/span>/gi;
    let match;
    
    while ((match = slotRegex.exec(html)) !== null) {
      const before = match[1] + match[3];
      const timeidx = parseInt(match[2]);
      const timeText = match[4].trim();
      const isDisabled = before.includes('disabled');

      let reason = null;
      if (isDisabled) {
        const spanMatch = html.substring(match.index, match.index + 500).match(/title="([^"]+)"/);
        reason = spanMatch ? spanMatch[1] : 'Unavailable';
      }

      slots.push({
        timeidx,
        time: timeText,
        available: !isDisabled,
        reason: isDisabled ? reason : null
      });
    }

    if (slots.length === 0) {
      console.log('  ⚠️ Using fallback regex parser...');
      const simpleRegex = /timeidx="(\d+)"[^>]*>\s*([\d:]+\s*[AP]M)\s*</gi;
      const disabledIdxRegex = /<input[^>]*disabled[^>]*timeidx="(\d+)"/gi;
      const disabledSet = new Set();
      
      let dm;
      while ((dm = disabledIdxRegex.exec(html)) !== null) {
        disabledSet.add(parseInt(dm[1]));
      }
      
      let sm;
      const seen = new Set();
      while ((sm = simpleRegex.exec(html)) !== null) {
        const idx = parseInt(sm[1]);
        if (seen.has(idx)) continue;
        seen.add(idx);
        
        slots.push({
          timeidx: idx,
          time: sm[2].trim(),
          available: !disabledSet.has(idx),
          reason: disabledSet.has(idx) ? 'Unavailable' : null
        });
      }
    }

    console.log(`  ✅ Parsed ${slots.length} slots, ${slots.filter(s=>!s.available).length} taken`);
    return slots.length > 0 ? slots : null;

  } catch (err) {
    console.error('❌ scrapeAvailability error:', err.message);
    return null;
  }
}

// ==========================================
// GET /api/debug-availability — debug only
// ==========================================
app.get('/api/debug-availability', async (req, res) => {
  const { date, employeeId, services } = req.query;
  const d = date || new Date().toISOString().split('T')[0];
  const e = employeeId || '0';
  const sids = services ? services.toString().split(',').map(s=>s.trim()).filter(Boolean) : [];
  try {
    const slots = await scrapeAvailabilityFromATSoft(d, e, sids);
    res.json({
      success: true,
      date: d,
      employeeId: e,
      slots_found: slots ? slots.length : 0,
      taken: slots ? slots.filter(s=>!s.available).length : 0,
      sample: slots ? slots.slice(0,5) : null,
      raw_result: slots
    });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'Milano Nail Spa Booking API',
    version: '3.0',
    mode: 'Cloud — No PC required!',
    routes: [
      'GET  /api/health',
      'GET  /api/employees',
      'GET  /api/technicians (alias)',
      'GET  /api/services',
      'GET  /api/closed-dates',
      'GET  /api/availability?date=YYYY-MM-DD&employeeId=0',
      'POST /api/booking'
    ]
  });
});

// ==========================================
// GET /api/health
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Milano Booking API v3.0 running!', time: new Date() });
});

// ==========================================
// GET /api/employees — scrape từ ATSoft HTML
// ==========================================
app.get('/api/employees', async (req, res) => {
  try {
    // Thử SQL trước (nếu PC bật)
    try {
      const db = await getPool();
      const result = await db.request().query(`
        SELECT EmployeeID, FullName, CellPhone
        FROM dbo.Employees WHERE Active = 1 AND IsOnline = 1 ORDER BY FullName
      `);
      return res.json({ success: true, source: 'sql', data: [
        { EmployeeID: 0, FullName: 'Anyone', CellPhone: '' },
        ...result.recordset
      ]});
    } catch (sqlErr) {
      console.log('⚠️ SQL unavailable, scraping ATSoft HTML...');
    }

    // Fallback: scrape từ ATSoft HTML
    const employees = await scrapeEmployeesFromHTML();
    res.json({ success: true, source: 'atsoft-html', data: employees });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// GET /api/technicians — alias
// ==========================================
app.get('/api/technicians', async (req, res) => {
  try {
    try {
      const db = await getPool();
      const result = await db.request().query(`
        SELECT EmployeeID, FullName, CellPhone
        FROM dbo.Employees WHERE Active = 1 AND IsOnline = 1 ORDER BY FullName
      `);
      return res.json({ success: true, source: 'sql', data: [
        { EmployeeID: 0, FullName: 'Anyone', CellPhone: '' },
        ...result.recordset
      ]});
    } catch (sqlErr) {
      console.log('⚠️ SQL unavailable, scraping ATSoft HTML...');
    }

    const employees = await scrapeEmployeesFromHTML();
    res.json({ success: true, source: 'atsoft-html', data: employees });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// GET /api/services
// ==========================================
app.get('/api/services', async (req, res) => {
  try {
    try {
      const db = await getPool();
      const result = await db.request().query(`
        SELECT CategoryID, CategoryName, ProductKey
        FROM dbo.Categories ORDER BY Page, Row
      `);
      return res.json({ success: true, source: 'sql', data: result.recordset });
    } catch (sqlErr) {
      console.log('⚠️ SQL unavailable, scraping ATSoft HTML...');
    }

    const services = await scrapeServicesFromHTML();
    res.json({ success: true, source: 'atsoft-html', data: services });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// GET /api/closed-dates — ngày nghỉ lễ từ ATSoft
// ==========================================
app.get('/api/closed-dates', async (req, res) => {
  try {
    const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)';
    const step1 = await fetchUrl(`${ATSOFT_BASE}/Book/${STORE_ID}`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' }
    });
    const cookies1 = (step1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf1Match = step1.body.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/);
    if (!csrf1Match) return res.json({ success: true, data: [] });

    const body2 = `__RequestVerificationToken=${encodeURIComponent(csrf1Match[1])}&SelectedEmployeeLocalID=0&SelectedServices=1`;
    const step2 = await fetchUrl(`${ATSOFT_BASE}/Book/Booking2`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies1
      },
      body: body2
    });

    // Parse disabled dates from flatpickr JS
    const html = step2.body;
    const disabledDates = [];
    const dateRegex = /disabledDates\.push\(new Date\('([^']+)'\)\)/g;
    let dm;
    while ((dm = dateRegex.exec(html)) !== null) {
      // Convert "7/4/2026 12:00:00 AM" → "2026-07-04"
      const d = new Date(dm[1]);
      if (!isNaN(d)) {
        const iso = d.toISOString().split('T')[0];
        if (!disabledDates.includes(iso)) disabledDates.push(iso);
      }
    }

    res.json({ success: true, data: disabledDates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// GET /api/availability
// ==========================================
app.get('/api/availability', async (req, res) => {
  try {
    const { date, employeeId, services } = req.query;
    if (!date) return res.status(400).json({ success: false, error: 'Missing date' });
    const serviceIds = services ? services.toString().split(',').map(s=>s.trim()).filter(Boolean) : [];

    // Try SQL first (PC on)
    try {
      const db = await getPool();
      const request = db.request();
      request.input('date', sql.Date, date);
      let query = `
        SELECT OnTime, EmployeeName, Services, StatusStr
        FROM dbo.Appointments
        WHERE CAST(OnDate AS DATE) = @date AND StatusStr != 'Cancelled'
      `;
      if (employeeId && employeeId !== '0') {
        request.input('empId', sql.Int, parseInt(employeeId));
        query += ` AND EmployeeID = @empId`;
      }
      const result = await request.query(query);
      return res.json({ success: true, source: 'sql', data: result.recordset });
    } catch (sqlErr) {
      console.log('⚠️ SQL unavailable, scraping ATSoft...');
    }

    // Fallback: scrape from ATSoft HTML
    const slots = await scrapeAvailabilityFromATSoft(date, employeeId || 0, serviceIds);
    if (slots && slots.length > 0) {
      return res.json({ success: true, source: 'atsoft-html', data: slots });
    }

    // Last fallback: return empty (let frontend handle)
    res.json({ success: true, source: 'fallback', data: [] });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// POST /api/booking
// ==========================================
app.post('/api/booking', async (req, res) => {
  try {
    const { customerName, customerPhone, employeeId, services, appointmentDate, appointmentTime, notes } = req.body;
    if (!customerName || !customerPhone || !appointmentDate || !appointmentTime) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const digits = customerPhone.replace(/\D/g, '');
    const formattedPhone = digits.length === 10
      ? `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`
      : customerPhone;
    const timeStart = formatTime12h(appointmentTime);
    const [h, m] = appointmentTime.split(':').map(Number);
    const timeEnd = formatTime12h(`${String(h+1).padStart(2,'0')}:${String(m).padStart(2,'0')}`);

    const result = await createAtsoftAppointment({
      appointmentDate, customerName,
      customerPhone: formattedPhone,
      employeeId: parseInt(employeeId) || 0,
      services, timeStart, timeEnd, notes
    });

    if (result.status === 200) {
      console.log(`📅 Booked: ${customerName} | ${services} | ${appointmentDate} ${timeStart}`);
      res.json({ success: true, message: 'Appointment booked successfully!' });
    } else {
      res.status(500).json({ success: false, error: `ATSoft error: ${result.body}` });
    }
  } catch (err) {
    console.error('booking error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, async () => {
  console.log(`✅ Milano Booking API v3.0 running on port ${PORT}`);
  console.log(`🌐 Mode: Cloud-first (ATSoft HTML scraping)`);
  console.log(`💾 SQL Server: fallback only`);
  // Pre-cache technicians
  try { await scrapeEmployeesFromHTML(); } catch(e) {}
  // Pre-login ATSoft
  await loginAtsoft();
});
