// ============================================================
// Milano Nail Spa Booking API — v4.0 (SQL-direct)
// File: C:\MILANO-BOOK\server.js
//
// Setup:
//   1. npm install express mssql cors dotenv
//   2. Create .env file (template at bottom of this file)
//   3. node server.js   (or)   pm2 restart Milano-Booking-API
//
// Public URL: https://api.milanonailspa529.com (via Cloudflare Tunnel)
// ============================================================

require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();

// ============================================================
// CORS — only allow your booking sites
// To open up during development, replace with: app.use(cors());
// ============================================================
const allowedOrigins = [
  'https://booking-832.pages.dev',
  'https://milanonailspa529.com',
  'https://www.milanonailspa529.com',
	'https://booking.milanonailspa529.com',
	'https://api.milanonailspa529.com',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500'  // VS Code Live Server
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn(`⚠️  CORS blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

// Simple request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
// DATABASE CONFIG (credentials from .env)
// ============================================================
const dbConfig = {
  server: process.env.DB_SERVER || '127.0.0.1',
  database: process.env.DB_NAME || 'DbProvider',
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || 'atsoft',
  port: parseInt(process.env.DB_PORT) || 1433,
  options: {
    encrypt: false,
    trustServerCertificate: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// ============================================================
// CONNECTION POOL — single shared pool, lazy init with retry
// ============================================================
let poolPromise;

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(dbConfig)
      .then(pool => {
        console.log('✅ Connected to SQL Server');
        return pool;
      })
      .catch(err => {
        console.error('❌ Database connection failed:', err.message);
        poolPromise = null;  // allow retry on next request
        throw err;
      });
  }
  return poolPromise;
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Milano Booking API v4.0 running',
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// GET /api/employees — list of active technicians
// ============================================================
app.get('/api/employees', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT EmployeeID, FullName FROM Employees WHERE Active = 1 ORDER BY FullName');
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('GET /api/employees error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET /api/available-techs?date=YYYY-MM-DD
// Returns only technicians who work on that day-of-week AND aren't on vacation.
// Useful for a "Date first, then Technician" booking flow.
// ============================================================
app.get('/api/available-techs', async (req, res) => {
  const { date } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid date (YYYY-MM-DD)' });
  }

  try {
    const pool = await getPool();
    // Day of week: 0=Sun ... 6=Sat, matches ATSoft's WorkDays bitmask
    const dayOfWeek = new Date(date + 'T12:00:00').getDay();
    const mask = 1 << dayOfWeek;

    // WorkDays bit is set AND (no vacation OR vacation window doesn't cover this date)
    const result = await pool.request()
      .input('mask', sql.Int, mask)
      .input('date', sql.Date, date)
      .query(`
        SELECT EmployeeID, FullName
        FROM Employees
        WHERE Active = 1
          AND (WorkDays & @mask) <> 0
          AND (
            DayOffStart IS NULL
            OR DayOffEnded IS NULL
            OR YEAR(DayOffStart) < 2015   -- ATSoft sentinel dates
            OR CAST(@date AS DATE) < CAST(DayOffStart AS DATE)
            OR CAST(@date AS DATE) > CAST(DayOffEnded AS DATE)
          )
        ORDER BY FullName
      `);

    res.json({ success: true, date, dayOfWeek, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    console.error('GET /api/available-techs error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET /api/services — list of available services
// Booking form expects fields: CategoryName, ProductKey, Price
// ProductKey categorizes the item (PED/MAN/WAX/KID/DIP/ART/POL/GX/SET/HAN).
// ATSoft's Products.CategoryName column is usually empty — we alias ProductName
// so the frontend has something to display. IsOnline = 1 filters to bookable items.
// ============================================================
app.get('/api/services', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        ProductID,
        ProductKey,
        ProductName AS CategoryName,
        Price
      FROM Products
      WHERE IsOnline = 1
        AND (RecordState IS NULL OR RecordState <> 9)
        AND ProductName IS NOT NULL
        AND LTRIM(RTRIM(ProductName)) <> ''
      ORDER BY ProductKey, ProductName
    `);
    res.json({ success: true, source: 'sql', count: result.recordset.length, data: result.recordset });
  } catch (err) {
    console.error('GET /api/services error:', err.message);
    // Fall back to a curated menu using field names the booking form expects
    res.json({
      success: true,
      data: getFallbackServices(),
      source: 'fallback',
      warning: err.message
    });
  }
});

// Fallback menu — matches the field names the booking form uses.
// ProductKey drives the category label (see getCatLabel in booking.html).
function getFallbackServices() {
  return [
    // Manicures
    { ProductKey: 'MAN01', CategoryName: 'Classic Manicure',     Price: 25 },
    { ProductKey: 'MAN02', CategoryName: 'Gel Manicure',         Price: 40 },
    { ProductKey: 'MAN03', CategoryName: 'French Manicure',      Price: 35 },
    // Pedicures
    { ProductKey: 'PED01', CategoryName: 'Classic Pedicure',     Price: 35 },
    { ProductKey: 'PED02', CategoryName: 'Gel Pedicure',         Price: 50 },
    { ProductKey: 'PED03', CategoryName: 'Deluxe Spa Pedicure',  Price: 55 },
    { ProductKey: 'PED04', CategoryName: 'Milano Signature Pedicure', Price: 75 },
    // Full Set
    { ProductKey: 'SET01', CategoryName: 'Acrylic Full Set',     Price: 55 },
    { ProductKey: 'SET02', CategoryName: 'Gel-X Full Set',       Price: 65 },
    { ProductKey: 'GX01',  CategoryName: 'Ombre Full Set',       Price: 70 },
    // Dip Powder
    { ProductKey: 'DIP01', CategoryName: 'Dip Powder',           Price: 50 },
    { ProductKey: 'DIP02', CategoryName: 'Dip with Tips',        Price: 60 },
    // Waxing
    { ProductKey: 'WAX01', CategoryName: 'Eyebrow Wax',          Price: 12 },
    { ProductKey: 'WAX02', CategoryName: 'Lip Wax',              Price: 8  },
    { ProductKey: 'WAX03', CategoryName: 'Chin Wax',             Price: 10 },
    // Nail Art
    { ProductKey: 'ART01', CategoryName: 'Nail Art (per nail)',  Price: 5  },
    { ProductKey: 'ART02', CategoryName: 'Chrome Design',        Price: 15 },
    // Polish Change
    { ProductKey: 'POL01', CategoryName: 'Polish Change - Hands', Price: 12 },
    { ProductKey: 'POL02', CategoryName: 'Polish Change - Feet',  Price: 15 },
    // Kids
    { ProductKey: 'KID01', CategoryName: 'Kids Manicure',        Price: 15 },
    { ProductKey: 'KID02', CategoryName: 'Kids Pedicure',        Price: 20 }
  ];
}

// ============================================================
// GET /api/availability — booked time slots for a tech on a date
// ============================================================
app.get('/api/availability', async (req, res) => {
  const { date, employeeId } = req.query;

  if (!date || !employeeId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters: date and employeeId'
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid date format. Use YYYY-MM-DD'
    });
  }

  const empId = parseInt(employeeId);
  if (isNaN(empId)) {
    return res.status(400).json({
      success: false,
      error: 'employeeId must be a number'
    });
  }

  try {
    const pool = await getPool();

    // Day of week from JavaScript: 0=Sun, 1=Mon, ..., 6=Sat.
    // Matches ATSoft's WorkDays bitmask convention (bit 0=Sun).
    // Using JS (not SQL DATEPART(dw)) avoids @@DATEFIRST dependency.
    const dayOfWeek = new Date(date + 'T12:00:00').getDay();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName  = dayNames[dayOfWeek];

    // Step 1: Look up the employee's schedule
    const empResult = await pool.request()
      .input('empId', sql.Int, empId)
      .query(`
        SELECT EmployeeID, FullName, WorkDays, DayOffStart, DayOffEnded
        FROM Employees
        WHERE EmployeeID = @empId
      `);

    if (empResult.recordset.length === 0) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    const emp = empResult.recordset[0];
    const workDaysMask = emp.WorkDays || 0;
    const worksThisDay = (workDaysMask & (1 << dayOfWeek)) !== 0;

    // Step 2A: Fixed weekly day off
    if (!worksThisDay) {
      console.log(`[schedule] ${emp.FullName} is off on ${dayName}s (WorkDays=${workDaysMask})`);
      return res.json({
        success: true,
        source: 'sql',
        isOffDay: true,
        offReason: 'weekly-schedule',
        message: `${emp.FullName} is off on ${dayName}s`,
        data: buildDummySlots()   // legacy fallback: frontend without isOffDay support still disables all
      });
    }

    // Step 2B: Vacation / time-off window (skip ATSoft's 2012 sentinel dates)
    if (emp.DayOffStart && emp.DayOffEnded) {
      const startYear = new Date(emp.DayOffStart).getFullYear();
      const looksLikeSentinel = startYear < 2015;
      if (!looksLikeSentinel) {
        const checkDate = new Date(date + 'T12:00:00').getTime();
        const offStart  = new Date(emp.DayOffStart).getTime();
        const offEnd    = new Date(emp.DayOffEnded).getTime();
        if (checkDate >= offStart && checkDate <= offEnd) {
          console.log(`[schedule] ${emp.FullName} on vacation ${date}`);
          return res.json({
            success: true,
            source: 'sql',
            isOffDay: true,
            offReason: 'vacation',
            message: `${emp.FullName} is on vacation this day`,
            data: buildDummySlots()
          });
        }
      }
    }

    // Step 3: Employee is working — return already-booked slots so frontend can disable them
    const result = await pool.request()
      .input('date', sql.Date, date)
      .input('empId', sql.Int, empId)
      .query(`
        SELECT OnTime
        FROM Appointments
        WHERE CAST(OnDate AS DATE) = @date
          AND EmployeeID = @empId
      `);

    res.json({
      success: true,
      source: 'sql',
      isOffDay: false,
      data: result.recordset
    });
  } catch (err) {
    console.error('GET /api/availability error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/booking — create a new appointment
// Matches ATSoft's real schema (based on sample data analysis).
// Frontend sends: customerName, customerPhone, customerEmail,
//                 employeeId, employeeName, services (string),
//                 appointmentDate (YYYY-MM-DD), appointmentTime (HH:MM 24hr),
//                 notes, duration (optional, defaults to 60 min)
// ============================================================
app.post('/api/booking', async (req, res) => {
  const {
    customerName,
    customerPhone,
    customerEmail,
    employeeId,
    employeeName,
    services,
    appointmentDate,    // YYYY-MM-DD (frontend field name)
    appointmentTime,    // HH:MM 24-hour, e.g. "14:30"
    notes,
    duration            // minutes, optional
  } = req.body;

  // Also accept alternate names for flexibility
  const date = appointmentDate || req.body.date;
  const time = appointmentTime || req.body.time;
  const durationMin = parseInt(duration) || 60;

  // Validation
  if (!customerName || !customerPhone || !employeeId || !date || !time) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: customerName, customerPhone, employeeId, appointmentDate, appointmentTime'
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ success: false, error: 'Invalid time format. Use HH:MM (24-hour)' });
  }

  try {
    const pool = await getPool();

    // Parse date + time into proper datetime objects
    const [year, month, day] = date.split('-').map(Number);
    const [startHour, startMin] = time.split(':').map(Number);

    const onDateObj = new Date(year, month - 1, day, startHour, startMin, 0);
    const endDateObj = new Date(onDateObj.getTime() + durationMin * 60 * 1000);

    // Format OnTime as ATSoft expects: "H:MM AM/PM - H:MM AM/PM"
    const onTimeStr = `${formatTime12(startHour, startMin)} - ${formatTime12(endDateObj.getHours(), endDateObj.getMinutes())}`;

    // DateKey format is MDDYYYY without zero padding (e.g. "7292023" for July 29, 2023)
    const dateKey = `${month}${String(day).padStart(2,'0')}${year}`;

    // Week / quarter calculations
    const weekNum = getISOWeekNumber(onDateObj);
    const weekKey = `${weekNum}${year}`;
    const biWeekNum = Math.ceil(weekNum / 2);
    const biWeekKey = `${biWeekNum}${year}`;
    const quarter = Math.ceil(month / 3);
    const quarterKey = `${quarter}${year}`;

    // Services as comma-separated string, capped at 128 chars
    const servicesStr = (Array.isArray(services) ? services.join(', ') : (services || '')).slice(0, 128);

    const recordGuid = generateGUID();
    const empName = (employeeName || '').slice(0, 64);

    const result = await pool.request()
      .input('onDate',        sql.DateTime,    onDateObj)
      .input('onTime',        sql.VarChar(64), onTimeStr)
      .input('endDate',       sql.DateTime,    endDateObj)
      .input('customerName',  sql.VarChar(64), customerName.slice(0, 64))
      .input('customerPhone', sql.VarChar(16), customerPhone.slice(0, 16))
      .input('email',         sql.VarChar(96), (customerEmail || '').slice(0, 96))
      .input('empId',         sql.Int,         parseInt(employeeId))
      .input('empName',       sql.VarChar(64), empName)
      .input('description',   sql.VarChar(256),(notes || 'Online booking').slice(0, 256))
      .input('services',      sql.VarChar(128),servicesStr)
      .input('statusStr',     sql.VarChar(32), 'Scheduled')  // matches ATSoft samples
      .input('recordGuid',    sql.VarChar(36), recordGuid)
      .input('onDay',         sql.Int,         day)
      .input('onMonth',       sql.Int,         month)
      .input('onYear',        sql.Int,         year)
      .input('dateKey',       sql.VarChar(10), dateKey)
      .input('onWeek',        sql.Int,         weekNum)
      .input('weekKey',       sql.VarChar(20), weekKey)
      .input('onBiWeek',      sql.Int,         biWeekNum)
      .input('biWeekKey',     sql.VarChar(20), biWeekKey)
      .input('onQuarter',     sql.Int,         quarter)
      .input('quarterKey',    sql.VarChar(20), quarterKey)
      .query(`
        INSERT INTO Appointments (
          OnDate, OnTime, EndDate,
          CustomerID, CustomerName, CustomerPhone, Email,
          EmployeeID, EmployeeName, TechName,
          Description, Services,
          StatusA, StatusS, StatusStr, Scheduled,
          RecordState, RecordGUID, EditTimestamp,
          OnDay, OnMonth, OnYear, DateKey,
          OnWeek, WeekKey, OnBiWeek, BiWeekKey,
          OnQuarter, QuarterKey,
          Locked, ByEmail, BySMS, RemindedSMS, RemindedEmail,
          ColorIdx, ColorArgb, BlockOff,
          IsOnline, ByRequest, ByRequestO,
          Paid, TotalPaid, TransactionID,
          RequestState, OnlineState, IsNew
        )
        OUTPUT INSERTED.AppointmentID
        VALUES (
          @onDate, @onTime, @endDate,
          0, @customerName, @customerPhone, @email,
          @empId, @empName, @empName,
          @description, @services,
          0, 0, @statusStr, 0,
          3, @recordGuid, GETDATE(),
          @onDay, @onMonth, @onYear, @dateKey,
          @onWeek, @weekKey, @onBiWeek, @biWeekKey,
          @onQuarter, @quarterKey,
          0, 0, 0, 0, 0,
          0, -1, 0,
          1, 0, 0,
          0, 0, '0',
          0, 3, 1
        )
      `);

    const newId = result.recordset[0]?.AppointmentID;
    console.log(`✅ Booking #${newId}: ${customerName} (${customerPhone}) with ${empName} on ${date} ${onTimeStr}`);

    res.json({
      success: true,
      appointmentId: newId,
      recordGuid,
      onTime: onTimeStr,
      message: 'Booking confirmed'
    });
  } catch (err) {
    console.error('POST /api/booking error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Helper functions ----------

// Build all 22 half-hour slots from 9 AM to 7 PM (matches booking.html time grid).
// Used to fill `data` when a tech is off, so frontends without isOffDay support
// still show every slot as "taken" and prevent booking.
function buildDummySlots() {
  const slots = [];
  for (let h = 9; h <= 19; h++) {
    ['00', '30'].forEach(m => {
      if (h === 19 && m === '30') return;
      const hour12 = h > 12 ? h - 12 : h;
      const ampm   = h >= 12 ? 'PM' : 'AM';
      slots.push({ OnTime: `${hour12}:${m} ${ampm}` });
    });
  }
  return slots;
}

// Convert 24-hour time to "H:MM AM/PM" (ATSoft's format, no leading zero on hour)
function formatTime12(h, m) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  return `${h12}:${mm} ${ampm}`;
}

// ISO 8601 week number (1-53)
function getISOWeekNumber(d) {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
}

// Simple RFC4122-ish GUID generator (good enough for a 36-char identifier)
function generateGUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================================
// DEBUG ENDPOINTS — REMOVE BEFORE GOING LIVE
// Useful for discovering ATSoft's actual schema.
// ============================================================

app.get('/api/debug/tables', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `);
    res.json({ tables: result.recordset.map(r => r.TABLE_NAME) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/schema/:tableName', async (req, res) => {
  const { tableName } = req.params;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('tbl', sql.NVarChar, tableName)
      .query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @tbl
        ORDER BY ORDINAL_POSITION
      `);
    res.json({ table: tableName, columns: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/sample/:tableName', async (req, res) => {
  const { tableName } = req.params;
  // Whitelist table name to prevent injection (since table names can't be parameterized)
  if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  try {
    const pool = await getPool();
    const result = await pool.request().query(`SELECT TOP 3 * FROM [${tableName}]`);
    res.json({
      table: tableName,
      columns: Object.keys(result.recordset[0] || {}),
      samples: result.recordset
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ERROR HANDLER (catches uncaught route errors)
// ============================================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3456;
app.listen(PORT, async () => {
  console.log('============================================');
  console.log(`✅ Milano Booking API v4.0 running on port ${PORT}`);
  console.log(`📡 Mode: SQL-direct (no HTML scraping)`);
  console.log(`🔒 CORS allowed: ${allowedOrigins.join(', ')}`);
  console.log('============================================');
  try {
    await getPool();
  } catch (err) {
    console.error('⚠️  Server started but database is unreachable. Will retry on first request.');
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.close();
  }
  process.exit(0);
});

/*
============================================================
.env FILE TEMPLATE — create as C:\MILANO-BOOK\.env
============================================================

DB_SERVER=127.0.0.1
DB_NAME=DbProvider
DB_USER=sa
DB_PASSWORD=atsoft
DB_PORT=1433
PORT=3456

============================================================
TEST URLS (use browser or iPhone)
============================================================

Public (via tunnel):
  https://api.milanonailspa529.com/api/health
  https://api.milanonailspa529.com/api/employees
  https://api.milanonailspa529.com/api/services
  https://api.milanonailspa529.com/api/availability?date=2026-06-30&employeeId=1
  https://api.milanonailspa529.com/api/debug/tables
  https://api.milanonailspa529.com/api/debug/schema/Appointments
  https://api.milanonailspa529.com/api/debug/sample/Appointments

Local (on Milano PC):
  http://localhost:3456/api/health

============================================================
DEPLOYMENT (after replacing this file)
============================================================

In CMD:
  cd C:\MILANO-BOOK
  pm2 restart Milano-Booking-API
  pm2 logs Milano-Booking-API --lines 30
*/
