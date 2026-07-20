let DATA = null;
let offcanvas = null;
let currentDriverId = null;
let typesSaved = false;
let chart = null;
let WORKING_THRESHOLDS = null;
let USER_TOKEN = null;
let LOADING = false;
let USER_LANGUAGE = 'es'; // Valor por defecto, se actualiza desde GPSWOX
let I18N = {}; // Traducciones cargadas dinámicamente
// ?lang capturado por el script inline de index.html ANTES de limpiar la URL,
// con respaldo a la URL actual por si el inline no corrió.
const _URL_LANG = (window.__DIQ_LANG)
  || (() => { try { return new URLSearchParams(location.search).get('lang'); } catch (e) { return null; } })();
let USER_UNITS = 'metric'; // Unidades: 'metric' (km/h, km) o 'imperial' (mph, mi) - desde GPSWOX
let USER_TIMEZONE = 'UTC'; // Zona horaria desde GPSWOX (ej: 'America/Bogota', 'Europe/Madrid')
let USER_HOUR_FORMAT = '24h'; // Formato de hora: '12h' o '24h' desde GPSWOX
let VEHICLE_GROUPS = []; // Grupos de vehículos desde GPSWOX
let _typesWereLoaded = false; // true si se encontraron tipos guardados

// Variables globales para filtros múltiples
let selectedVehicles = new Set(); // IDs de vehículos seleccionados
let selectedDrivers = new Set(); // IDs de conductores seleccionados

// ============================================
// SISTEMA DE VALIDACIÓN Y PREVENCIÓN DE ERRORES
// ============================================

// Verificar que una función existe antes de ejecutarla
function safeCall(fn, ...args) {
  if (typeof fn === 'function') {
    try {
      return fn(...args);
    } catch (e) {
      console.error(`Error ejecutando función ${fn.name || 'anónima'}:`, e);
      return null;
    }
  } else {
    console.error(`Función no definida: ${typeof fn}`);
    return null;
  }
}

// Ejecutar función async de forma segura con fallback
async function safeCallAsync(fn, fallback = null, ...args) {
  if (typeof fn === 'function') {
    try {
      const result = await fn(...args);
      return result !== null && result !== undefined ? result : fallback;
    } catch (e) {
      console.error(`Error ejecutando función async ${fn.name || 'anónima'}:`, e);
      return fallback;
    }
  } else {
    console.warn(`Función async no definida: ${typeof fn}. Usando fallback.`);
    return fallback;
  }
}

// Verificar integridad de funciones críticas al inicio
function validateCriticalFunctions() {
  const required = [
    { name: 'loadUserLanguage', critical: false }, // Tiene fallback
    { name: 'loadI18n', critical: true },
    { name: 'updateBranding', critical: false }, // Tiene fallback
    { name: 'validateToken', critical: true },
    { name: 'loadVehicles', critical: true },
    { name: 'loadDrivers', critical: true },
    { name: 'loadEvents', critical: true },
    { name: 'formatSpeed', critical: false } // Tiene safeFormatSpeed como fallback
  ];
  
  const missing = [];
  const warnings = [];
  
  for (const fn of required) {
    let exists = false;
    try {
      // Intentar evaluar la función en el scope actual
      if (typeof eval(fn.name) === 'function') {
        exists = true;
      }
    } catch (e) {
      // Si eval falla, verificar en window
      try {
        if (typeof window[fn.name] === 'function') {
          exists = true;
        }
      } catch (e2) {
        // Ignorar errores de verificación
      }
    }
    
    if (!exists) {
      if (fn.critical) {
        missing.push(fn.name);
      } else {
        warnings.push(fn.name);
      }
    }
  }
  
  if (warnings.length > 0) {
    console.warn('⚠️ Funciones opcionales no definidas (tienen fallbacks):', warnings);
  }
  
  if (missing.length > 0) {
    console.error('❌ FUNCIONES CRÍTICAS FALTANTES:', missing);
    console.error('La aplicación NO funcionará correctamente sin estas funciones.');
    return false;
  }
  
  if (warnings.length > 0 && missing.length === 0) {
    console.info('✅ Todas las funciones críticas están presentes.');
    console.info('⚠️ Algunas funciones opcionales faltan pero tienen fallbacks.');
  } else if (missing.length === 0) {
    console.info('✅ Todas las funciones requeridas están presentes.');
  }
  
  return true;
}

// Configuración de ranking
let RANKING_ORDER = 'asc'; // 'asc' = peor a mejor, 'desc' = mejor a peor
let RANKING_MAX_SCORE = 100; // Mostrar todos por defecto (el usuario puede filtrar desde el menú)

// Paginación
const PAGE_SIZE = 30;
let driversPage = 1;
let eventsPage  = 1;

// Umbrales de DISPARO por defecto, en m/s² (deben coincidir con los 'low' del
// backend config/scoring.json). El backend es la fuente de verdad; esto es el
// fallback si la API no responde. accel/braking/corner = aceleración/frenada/giro.
const RECOMMENDED = {
  auto:        { accel: 3.0, braking: 3.4, corner: 3.6 },
  camioneta:   { accel: 2.8, braking: 3.2, corner: 3.3 },
  camion:      { accel: 2.4, braking: 2.7, corner: 2.9 },
  minibus:     { accel: 2.6, braking: 3.0, corner: 3.2 },
  bus:         { accel: 2.6, braking: 2.9, corner: 3.1 },
  tractomula:  { accel: 2.2, braking: 2.4, corner: 2.6 },
  moto:        { accel: 3.8, braking: 4.3, corner: 4.5 }
};

const SECTOR_PROFILES = {
  escolar: {
    label:    'Transporte Escolar',
    sublabel: 'Pasajeros menores de edad — máxima exigencia',
    detail:   'Aplicable a cualquier vehículo que transporte estudiantes. Los umbrales son los más estrictos del sistema: cualquier maniobra brusca representa un riesgo directo para los pasajeros. Recomendado también para transporte universitario y de personal.',
    applies:  ['auto', 'camioneta', 'minibus', 'bus'],
    thresholds: { // m/s² — más estrictos (más sensibles) que el default
      auto:      { accel: 2.2, braking: 2.4, corner: 2.6 },
      camioneta: { accel: 2.2, braking: 2.4, corner: 2.6 },
      minibus:   { accel: 2.0, braking: 2.2, corner: 2.4 },
      bus:       { accel: 2.0, braking: 2.2, corner: 2.3 },
    }
  },
  carga_peligrosa: {
    label:    'Carga Peligrosa',
    sublabel: 'Materiales peligrosos, líquidos o explosivos',
    detail:   'Para vehículos que transportan sustancias clasificadas como peligrosas: combustibles, químicos, líquidos a presión o materiales explosivos. El riesgo no es solo para el conductor — cualquier maniobra brusca puede desencadenar un derrame, explosión o emergencia química. Los umbrales son los más bajos del sistema.',
    applies:  ['camion', 'tractomula'],
    thresholds: { // m/s² — los más estrictos del sistema
      camion:     { accel: 1.8, braking: 2.0, corner: 2.2 },
      tractomula: { accel: 1.6, braking: 1.8, corner: 2.0 },
    }
  }
};

let VEHICLE_CUSTOM_NAMES = JSON.parse(localStorage.getItem('driveiq_vehicle_names') || '{}');

const VEHICLE_ICONS = {
  // Sedán — capó largo, techo con pendiente, maletero, 2 ruedas
  auto: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 28" width="56" height="28" fill="none" stroke="#FBBF24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2,21 L2,18 L5,18 L9,12 L16,8 L22,7 L38,7 L44,12 L49,17 L52,18 L54,18 L54,21 L48,21 A5,5 0 0 1 38,21 L18,21 A5,5 0 0 1 8,21 L2,21"/>
    <circle cx="13" cy="21" r="5"/>
    <circle cx="43" cy="21" r="5"/>
    <line x1="22" y1="7" x2="20" y2="18"/>
    <line x1="38" y1="7" x2="39" y2="18"/>
  </svg>`,
  // Pickup — cabina con techo + cama plana descubierta más baja
  camioneta: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 28" width="56" height="28" fill="none" stroke="#FBBF24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2,21 L2,18 L5,18 L8,11 L14,7 L28,7 L29,10 L29,21 L18,21 A5,5 0 0 1 8,21 L2,21"/>
    <circle cx="13" cy="21" r="5"/>
    <line x1="20" y1="7" x2="20" y2="18"/>
    <path d="M29,13 L54,13 L54,21 L48,21 A5,5 0 0 1 38,21 L29,21"/>
    <circle cx="43" cy="21" r="5"/>
  </svg>`,
  // Camión caja — morro pronunciado + furgón alto cuadrado, 3 ruedas
  camion: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 28" width="56" height="28" fill="none" stroke="#FBBF24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2,21 L2,12 L4,9 L9,5 L20,5 L21,21 L15,21 A4,4 0 0 1 7,21 L2,21"/>
    <line x1="5" y1="13" x2="8" y2="9"/>
    <line x1="8" y1="9" x2="17" y2="9"/>
    <line x1="17" y1="9" x2="17" y2="14"/>
    <rect x="21" y="5" width="33" height="16"/>
    <circle cx="11" cy="21" r="4"/>
    <circle cx="34" cy="21" r="4"/>
    <circle cx="44" cy="21" r="4"/>
    <line x1="30" y1="21" x2="38" y2="21"/>
    <line x1="48" y1="21" x2="54" y2="21"/>
  </svg>`,
  // Minibús — van con frente redondeado y 4 ventanas
  minibus: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 28" width="56" height="28" fill="none" stroke="#FBBF24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2,21 L2,11 L5,7 L9,6 L47,6 L51,8 L54,12 L54,21 L48,21 A5,5 0 0 1 38,21 L18,21 A5,5 0 0 1 8,21 L2,21"/>
    <circle cx="13" cy="21" r="5"/>
    <circle cx="43" cy="21" r="5"/>
    <rect x="7" y="9" width="7" height="6" rx="1"/>
    <rect x="17" y="9" width="7" height="6" rx="1"/>
    <rect x="27" y="9" width="7" height="6" rx="1"/>
    <rect x="37" y="9" width="7" height="6" rx="1"/>
  </svg>`,
  // Bus — cuerpo largo completamente recto, 5 ventanas en fila
  bus: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 28" width="56" height="28" fill="none" stroke="#FBBF24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2,21 L2,5 L54,5 L54,21 L48,21 A5,5 0 0 1 38,21 L18,21 A5,5 0 0 1 8,21 L2,21"/>
    <circle cx="13" cy="21" r="5"/>
    <circle cx="43" cy="21" r="5"/>
    <rect x="4" y="8" width="6" height="5" rx="1"/>
    <rect x="13" y="8" width="7" height="5" rx="1"/>
    <rect x="23" y="8" width="7" height="5" rx="1"/>
    <rect x="33" y="8" width="7" height="5" rx="1"/>
    <rect x="43" y="8" width="7" height="5" rx="1"/>
  </svg>`,
  // Tractomula — cabina alta semi + tráiler largo separado, 4 ruedas
  tractomula: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 28" width="56" height="28" fill="none" stroke="#FBBF24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2,21 L2,13 L4,9 L9,5 L18,5 L21,8 L22,21 L15,21 A4,4 0 0 1 7,21 L2,21"/>
    <line x1="5" y1="13" x2="8" y2="9"/>
    <line x1="8" y1="9" x2="16" y2="9"/>
    <line x1="16" y1="9" x2="16" y2="14"/>
    <rect x="24" y="7" width="30" height="14"/>
    <circle cx="10" cy="21" r="4"/>
    <circle cx="31" cy="21" r="4"/>
    <circle cx="41" cy="21" r="4"/>
    <circle cx="49" cy="21" r="4"/>
    <line x1="27" y1="21" x2="35" y2="21"/>
    <line x1="45" y1="21" x2="53" y2="21"/>
  </svg>`,
  // Moto — dos ruedas GRANDES, horquilla, manillar en T, depósito y asiento
  moto: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 28" width="56" height="28" fill="none" stroke="#FBBF24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="20" r="7"/>
    <circle cx="44" cy="20" r="7"/>
    <path d="M19,20 L22,13 L30,11 L38,13 L41,20"/>
    <line x1="22" y1="13" x2="17" y2="18"/>
    <line x1="15" y1="9" x2="25" y2="9"/>
    <line x1="15" y1="9" x2="16" y2="13"/>
    <line x1="25" y1="9" x2="23" y2="13"/>
    <path d="M28,11 Q31,7 35,11"/>
  </svg>`
};


// Detectar dinámicamente la URL base de la API según el hostname actual
// Esto permite que cada cliente use su propio subdominio
function getApiBase() {
  const hostname = window.location.hostname;
  const protocol = window.location.protocol;
  
  // Si es localhost, usar el puerto local
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:4010/api';
  }
  
  // Para cualquier otro dominio, usar el proxy nginx en el mismo host (sin puerto)
  // El nginx gateway en puerto 80 proxea /api/ → localhost:3100
  return `${protocol}//${hostname}/api`;
}

const API_BASE = getApiBase();

// Cargar traducciones desde archivo i18n
async function loadI18n(lang) {
  try {
    const supportedLangs = ['en', 'es', 'pt', 'fr', 'de', 'it'];
    const langCode = supportedLangs.includes(lang) ? lang : 'es'; // Fallback a español
    
    const response = await fetch(`i18n/${langCode}.json`);
    if (response.ok) {
      I18N = await response.json();
      return true;
    }
  } catch (e) {
    console.error('Error cargando i18n:', e);
  }
  
  // Fallback: cargar español si falla
  try {
    const response = await fetch('i18n/es.json');
    if (response.ok) {
      I18N = await response.json();
      USER_LANGUAGE = 'es';
      return true;
    }
  } catch (e) {
    console.error('Error cargando i18n fallback:', e);
  }
  
  // Último fallback: traducciones mínimas hardcodeadas
  I18N = {
    'app.name': 'DriveIQ',
    'app.slogan': 'Inteligencia de conducción y análisis de rendimiento'
  };
  return false;
}

// Función de traducción mejorada
function t(key) {
  return I18N[key] || key;
}

// Traduce el DOM bajo `root` usando I18N con el TEXTO ESPAÑOL como clave natural.
// En español es no-op (es.json no tiene claves naturales → el DOM ya está en español).
// En en/pt, los archivos i18n traen "frase en español": "traducción" y se reemplaza
// el texto exacto de nodos y de atributos (placeholder/title/aria-label).
let _translating = false;
function translateDOM(root) {
  root = root || document.body;
  if (!root || USER_LANGUAGE === 'es') return;
  _translating = true;
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(n => {
      const key = n.nodeValue.trim();
      if (!key) return;
      const tr = I18N[key];
      if (tr && tr !== key) n.nodeValue = n.nodeValue.replace(key, tr);
    });
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(el => {
      ['placeholder', 'title', 'aria-label'].forEach(a => {
        const v = el.getAttribute(a);
        const tr = v && I18N[v.trim()];
        if (tr && tr !== v.trim()) el.setAttribute(a, tr);
      });
    });
  } catch (e) { console.error('translateDOM:', e); }
  _translating = false;
}

// Observa el DOM y traduce el contenido que se renderiza después (modales, detalle
// de conductor, etc.). Debounced; se ignora mientras translateDOM está corriendo
// (las traducciones no son claves → no hay bucle). No-op en español.
let _i18nObserver = null;
function startI18nObserver() {
  if (_i18nObserver || USER_LANGUAGE === 'es' || !document.body) return;
  let pending = false;
  _i18nObserver = new MutationObserver(() => {
    if (_translating || pending) return;
    pending = true;
    setTimeout(() => { pending = false; translateDOM(document.body); }, 200);
  });
  _i18nObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// Cargar idioma desde GPSWOX
async function loadUserLanguage(token) {
  // Override opcional ?lang=es|en|pt para previsualizar/probar un idioma sin cambiar la cuenta.
  const urlLang = _URL_LANG;
  if (urlLang && ['es', 'en', 'pt', 'fr', 'de', 'it'].includes(urlLang)) {
    USER_LANGUAGE = urlLang;
    await loadI18n(urlLang);
    updateBranding(); updateTableHeaders();
    translateDOM(document.body);
    startI18nObserver();
    return true;
  }
  try {
    const r = await fetch(`${API_BASE}/config/user-language?token=${encodeURIComponent(token)}`);
    if (r.ok) {
      const data = await r.json();
      if (data.status === 'ok' && data.language) {
        // Normalizar código de idioma (es, en, pt, fr, de, it, etc.)
        const lang = data.language.toLowerCase().substring(0, 2);
        USER_LANGUAGE = lang;
        
        // Cargar traducciones para ese idioma
        await loadI18n(lang);
        
        // Actualizar UI
        updateBranding();
        updateTableHeaders(); // Actualizar encabezados de tabla
        // Actualizar labels de filtros si ya están cargados
        if (document.getElementById('selectAllVehiclesLabel')) {
          document.getElementById('selectAllVehiclesLabel').textContent = t('select_all');
        }
        if (document.getElementById('selectAllDriversLabel')) {
          document.getElementById('selectAllDriversLabel').textContent = t('select_all');
        }
        // Traducir el shell estático (menú, encabezados, botones, etiquetas).
        translateDOM(document.body);
        startI18nObserver();
        return true;
      }
    }
  } catch (e) {
    console.error('Error cargando idioma desde GPSWOX:', e);
  }
  
  // Fallback: cargar español
  USER_LANGUAGE = 'es';
  await loadI18n('es');
  updateBranding();
  updateTableHeaders(); // Actualizar encabezados de tabla
  return false;
}

// Cargar unidades de medida desde GPSWOX
// Función crítica - debe existir siempre con fallback seguro
async function loadUserUnits(token) {
  try {
    if (!token) {
      console.warn('loadUserUnits: token no proporcionado, usando unidades por defecto (metric)');
      USER_UNITS = 'metric';
      return false;
    }
    
    // Verificar que API_BASE esté definido
    if (typeof API_BASE === 'undefined') {
      console.warn('loadUserUnits: API_BASE no definido, usando unidades por defecto (metric)');
      USER_UNITS = 'metric';
      return false;
    }
    
    const r = await fetch(`${API_BASE}/config/user-units?token=${encodeURIComponent(token)}`);
    
    // Si el endpoint no existe (404), usar fallback sin error
    if (!r.ok) {
      if (r.status === 404) {
        console.warn('⚠️ Endpoint /api/config/user-units no disponible, usando unidades métricas por defecto');
      } else {
        console.warn(`⚠️ Error HTTP ${r.status} en /api/config/user-units, usando unidades métricas por defecto`);
      }
      USER_UNITS = 'metric';
      return false;
    }
    
    const data = await r.json();
    if (data.status === 'ok' && data.units) {
      // Normalizar unidades: 'metric' (km/h, km) o 'imperial' (mph, mi)
      USER_UNITS = (data.units === 'imperial') ? 'imperial' : 'metric';
      return true;
    }
  } catch (e) {
    console.error('Error cargando unidades desde GPSWOX:', e);
    // No lanzar error, solo usar fallback
  }
  
  // Fallback seguro: métrico por defecto
  USER_UNITS = 'metric';
  return false;
}

// Cargar timezone y formato de hora desde GPSWOX
async function loadUserTimezone(token) {
  try {
    if (!token || typeof API_BASE === 'undefined') {
      USER_TIMEZONE = 'UTC';
      USER_HOUR_FORMAT = '24h';
      return false;
    }
    
    const r = await fetch(`${API_BASE}/config/user-timezone?token=${encodeURIComponent(token)}`);
    if (r.ok) {
      const data = await r.json();
      if (data.status === 'ok') {
        USER_TIMEZONE = data.timezone || 'UTC';
        USER_HOUR_FORMAT = data.hourFormat || '24h';
        return true;
      }
    }
  } catch (e) {
    console.error('Error cargando timezone desde GPSWOX:', e);
  }
  
  // Fallback seguro
  USER_TIMEZONE = 'UTC';
  USER_HOUR_FORMAT = '24h';
  return false;
}

// Cargar grupos de vehículos desde GPSWOX
async function loadVehicleGroups(token) {
  try {
    if (!token || typeof API_BASE === 'undefined') {
      VEHICLE_GROUPS = [];
      return false;
    }
    
    const r = await fetch(`${API_BASE}/config/vehicle-groups?token=${encodeURIComponent(token)}`);
    
    // Si el endpoint no existe (404), usar fallback sin error
    if (!r.ok) {
      if (r.status === 404) {
        console.warn('⚠️ Endpoint /api/config/vehicle-groups no disponible, usando grupos vacíos por defecto');
      } else {
        console.warn(`⚠️ Error HTTP ${r.status} en /api/config/vehicle-groups, usando grupos vacíos por defecto`);
      }
      VEHICLE_GROUPS = [];
      return false;
    }
    
    const data = await r.json();
    if (data.status === 'ok' && Array.isArray(data.groups)) {
      VEHICLE_GROUPS = data.groups;
      console.log(`✅ ${data.groups.length} grupos de vehículos cargados desde GPSWOX`);
      return true;
    }
  } catch (e) {
    console.error('Error cargando grupos de vehículos desde GPSWOX:', e);
  }
  
  // Fallback seguro: array vacío
  VEHICLE_GROUPS = [];
  return false;
}

// Formatear velocidad con unidades según configuración GPSWOX
// Función crítica - debe existir siempre con fallback seguro
function formatSpeed(speed) {
  try {
    if (!speed && speed !== 0) return '';
    const speedNum = parseFloat(speed) || 0;
    
    // Validar que USER_UNITS esté definido, si no usar 'metric' por defecto
    const units = typeof USER_UNITS !== 'undefined' ? USER_UNITS : 'metric';
    
    if (units === 'imperial') {
      // Convertir km/h a mph (1 km/h = 0.621371 mph)
      const mph = Math.round(speedNum * 0.621371);
      return `${mph} mph`;
    } else {
      // Métrico: km/h (fallback por defecto)
      return `${Math.round(speedNum)} km/h`;
    }
  } catch (e) {
    console.error('Error en formatSpeed:', e);
    // Fallback seguro: devolver valor sin unidades si hay error
    return speed ? `${Math.round(parseFloat(speed) || 0)}` : '';
  }
}

// Formatear distancia con unidades según configuración GPSWOX
// Función crítica - debe existir siempre con fallback seguro
function formatDistance(distance) {
  try {
    if (!distance && distance !== 0) return '';
    const distanceNum = parseFloat(distance) || 0;
    
    // Validar que USER_UNITS esté definido, si no usar 'metric' por defecto
    const units = typeof USER_UNITS !== 'undefined' ? USER_UNITS : 'metric';
    
    if (units === 'imperial') {
      // Convertir km a millas (1 km = 0.621371 mi)
      const miles = (distanceNum * 0.621371).toFixed(2);
      return `${miles} mi`;
    } else {
      // Métrico: km (fallback por defecto)
      return `${distanceNum.toFixed(2)} km`;
    }
  } catch (e) {
    console.error('Error en formatDistance:', e);
    // Fallback seguro: devolver valor sin unidades si hay error
    return distance ? `${(parseFloat(distance) || 0).toFixed(2)}` : '';
  }
}

// Wrapper seguro para formatSpeed (prevenir errores si la función no existe)
function safeFormatSpeed(speed) {
  if (typeof formatSpeed === 'function') {
    return formatSpeed(speed);
  } else {
    // Fallback si formatSpeed no está definida
    console.warn('formatSpeed no está definida, usando formato simple');
    return speed ? `${Math.round(parseFloat(speed) || 0)}` : '';
  }
}

// Formatear fecha y hora según timezone y formato GPSWOX
function formatDateTime(timestamp, options = {}) {
  try {
    if (!timestamp) return '';
    
    // Convertir timestamp a Date
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';
    
    // Validar timezone (usar Intl si está disponible, sino UTC)
    const timezone = (typeof USER_TIMEZONE !== 'undefined' && USER_TIMEZONE) ? USER_TIMEZONE : 'UTC';
    const hourFormat = (typeof USER_HOUR_FORMAT !== 'undefined' && USER_HOUR_FORMAT) ? USER_HOUR_FORMAT : '24h';
    
    // Configurar opciones de formato
    const formatOptions = {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      ...options
    };
    
    // Ajustar formato de hora según GPSWOX (12h o 24h)
    if (hourFormat === '12h') {
      formatOptions.hour12 = true;
    } else {
      formatOptions.hour12 = false;
    }
    
    // Formatear usando Intl.DateTimeFormat
    try {
      const formatter = new Intl.DateTimeFormat(USER_LANGUAGE || 'es', formatOptions);
      return formatter.format(date);
    } catch (e) {
      // Fallback si timezone no es válido
      const fallbackOptions = { ...formatOptions, timeZone: 'UTC' };
      const fallbackFormatter = new Intl.DateTimeFormat(USER_LANGUAGE || 'es', fallbackOptions);
      return fallbackFormatter.format(date);
    }
  } catch (e) {
    console.error('Error formateando fecha:', e);
    // Fallback seguro
    try {
      return new Date(timestamp).toLocaleString(USER_LANGUAGE || 'es');
    } catch (e2) {
      return timestamp ? String(timestamp) : '';
    }
  }
}

// Formatear solo fecha (sin hora)
function formatDate(timestamp) {
  return formatDateTime(timestamp, { 
    hour: undefined, 
    minute: undefined,
    hour12: false 
  });
}

// Formatear solo hora (sin fecha)
function formatTime(timestamp) {
  const timezone = (typeof USER_TIMEZONE !== 'undefined' && USER_TIMEZONE) ? USER_TIMEZONE : 'UTC';
  const hourFormat = (typeof USER_HOUR_FORMAT !== 'undefined' && USER_HOUR_FORMAT) ? USER_HOUR_FORMAT : '24h';
  
  const options = {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: hourFormat === '12h'
  };
  
  try {
    const date = new Date(timestamp);
    const formatter = new Intl.DateTimeFormat(USER_LANGUAGE || 'es', options);
    return formatter.format(date);
  } catch (e) {
    return new Date(timestamp).toLocaleTimeString(USER_LANGUAGE || 'es');
  }
}

// Actualizar branding (nombre y slogan)
function updateBranding() {
  const appNameEl = document.getElementById('appName') || document.querySelector('.h4.mb-0');
  const appSubtitleEl = document.getElementById('appSubtitle');
  const titleEl = document.querySelector('title');
  
  if (appNameEl) {
    appNameEl.textContent = t('app.name'); // Siempre "DriveIQ" - NUNCA se traduce
  }
  
  if (appSubtitleEl) {
    appSubtitleEl.textContent = t('app.slogan'); // Se traduce según idioma de GPSWOX
  }
  
  if (titleEl) {
    titleEl.textContent = `${t('app.name')} — ${t('app.slogan')}`;
  }
}

// Actualizar encabezados de tabla (ej: "Trip" -> "Viaje")
function updateTableHeaders() {
  try {
    // Actualizar encabezado "Trip" en tabla principal de eventos
    const thTrip = document.getElementById('thTrip');
    if (thTrip) {
      thTrip.textContent = t('table.trip') || t('trip') || 'Viaje';
    }
    
    // Actualizar encabezado "Trip" en tabla de detalle de conductor
    const thTripDetail = document.getElementById('thTripDetail');
    if (thTripDetail) {
      thTripDetail.textContent = t('table.trip') || t('trip') || 'Viaje';
    }
  } catch (e) {
    console.error('Error en updateTableHeaders:', e);
  }
}

// Convertir tipo interno de vehículo a nombre traducido usando i18n
// Función crítica para mantener consistencia en toda la aplicación
function getVehicleTypeName(type) {
  try {
    if (!type) return '';
    // Nombre personalizado por país tiene prioridad
    const canonical = { car: 'auto', truck: 'camion', motorcycle: 'moto' }[type] || type;
    if (VEHICLE_CUSTOM_NAMES[canonical]) return VEHICLE_CUSTOM_NAMES[canonical];
    // Mapeo de tipos internos a claves i18n
    const typeMap = {
      'auto': 'vehicle.car',
      'car': 'vehicle.car',
      'camioneta': 'vehicle.pickup',
      'pickup': 'vehicle.pickup',
      'camion': 'vehicle.truck',
      'truck': 'vehicle.truck',
      'minibus': 'vehicle.minibus',
      'van': 'vehicle.minibus',
      'bus': 'vehicle.bus',
      'tractomula': 'vehicle.semi',
      'semi': 'vehicle.semi',
      'moto': 'vehicle.motorcycle',
      'motorcycle': 'vehicle.motorcycle'
    };
    const i18nKey = typeMap[type] || typeMap[type.toLowerCase()] || `vehicle.${type}`;
    const translated = t(i18nKey) || t(type) || type;
    if (translated === i18nKey || translated === type) {
      return type.charAt(0).toUpperCase() + type.slice(1);
    }
    return translated;
  } catch (e) {
    console.error('Error en getVehicleTypeName:', e);
    return type || '';
  }
}

function formatVehicleName(veh) {
  if (!veh) return '';
  // Intentar obtener el nombre del vehículo de diferentes campos
  const name = veh.name || veh.plate || veh.registration_number || veh.unit_id || '';
  const model = veh.model || '';
  
  if (name && model && model.trim() && model.trim() !== name.trim()) {
    return name + ' - ' + model;
  }
  return name || (veh.unit_id ? `Vehículo ${veh.unit_id}` : 'Sin nombre');
}

function getTokenFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || null;
}

async function getTokenFromSession() {
  // Intercambia el SID (de GPSwox POST /auth) por el token real
  const sid = sessionStorage.getItem('_diq_pending_sid');
  if (!sid) return null;
  sessionStorage.removeItem('_diq_pending_sid');
  try {
    const r = await fetch(`/api/auth/exchange?s=${encodeURIComponent(sid)}`);
    if (r.ok) {
      const d = await r.json();
      if (d.token) return d.token;
    }
  } catch (_) {}
  return null;
}

async function validateToken(token) {
  try {
    const r = await fetch(`${API_BASE}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (!r.ok) {
      console.error('Error HTTP al validar token:', r.status);
      return { status: 'error', valid: false };
    }
    const data = await r.json();
    if (data.status === 'ok' && data.valid) {
      return data;
    }
    return { status: 'error', valid: false };
  } catch (e) {
    console.error('Error validando token:', e);
    return { status: 'error', valid: false };
  }
}

async function loadVehicles(token) {
  try {
    console.log(`🚗 Cargando vehículos desde: ${API_BASE}/vehicles?token=...`);
    const r = await fetch(`${API_BASE}/vehicles?token=${encodeURIComponent(token)}`);
    
    if (!r.ok) {
      console.error(`❌ Error HTTP al cargar vehículos: ${r.status} ${r.statusText}`);
      return [];
    }
    
    const data = await r.json();
    console.log(`📥 Respuesta vehículos:`, { 
      status: data.status, 
      vehiclesCount: data.vehicles?.length || 0,
      hasVehicles: !!data.vehicles 
    });
    
    if (data.status === 'ok' && data.vehicles && Array.isArray(data.vehicles)) {
      const mapped = data.vehicles.map(v => {
        const plate = v.name || v.plate || '';
        let model = v.model || '';
        if (model && model.trim() === plate.trim()) model = '';
        return {
          unit_id: v.vehicle_id?.toString() || v.id?.toString() || '',
          plate: plate,
          model: model,
          type: v.type || '',
          sensors: v.has_accelerometer ? ['accelerometer'] : [],
          speed_alert: { enabled: true, speed_kmh: 90 }
        };
      });
      console.log(`✅ ${mapped.length} vehículos mapeados correctamente`);
      return mapped;
    } else {
      console.warn('⚠️ Respuesta de vehículos no tiene formato esperado:', data);
      return [];
    }
  } catch (e) {
    console.error('❌ Error cargando vehículos:', e);
    console.error('Stack:', e.stack);
    return [];
  }
}

async function loadDrivers(token) {
  try {
    const r = await fetch(`${API_BASE}/drivers?token=${encodeURIComponent(token)}`);
    const data = await r.json();
    if (data.status === 'ok' && data.drivers) {
      return data.drivers.map(d => ({
        driver_id:    d.driver_id?.toString() || d.id?.toString() || '',
        name:         d.name || '',
        vehicle_name: d.vehicle_name || d.name || '',
        has_driver:   d.has_driver === true,
        conductor_id: d.conductor_id || null,
        unit_id:      d.unit_id?.toString() || d.vehicle_id?.toString() || '',
        score:        d.score || 0,
        events_count: d.events_count || 0,
        type:         d.type || '',
        online:       d.online || 'offline',
      }));
    }
    return [];
  } catch (e) {
    console.error('Error cargando conductores:', e);
    return [];
  }
}

async function loadEvents(token, from, to) {
  try {
    const url = `${API_BASE}/events?token=${encodeURIComponent(token)}${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status === 'ok' && data.events) {
      return data.events.map(e => ({
        trip_id: e.trip_id || '',
        driver_id: e.driver_id?.toString() || e.vehicle_id?.toString() || '',
        vehicle_id: e.vehicle_id?.toString() || e.driver_id?.toString() || '',
        vehicle_name: e.vehicle_name || '',
        driver: e.driver || '',
        source: e.source || '',
        type: e.type || '',
        severity: e.severity || 'medio',
        ts: e.ts || e.timestamp || new Date().toISOString(),
        lat: e.lat || 0,
        lon: e.lon || 0,
        speed: e.speed || ''
      }));
    }
    return [];
  } catch (e) {
    console.error('Error cargando eventos:', e);
    return [];
  }
}

async function loadServices(token, deviceId) {
  try {
    const url = `${API_BASE}/services?device_id=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status === 'ok' && data.data) {
      return {
        services: data.data,
        has_expired: data.has_expired || false,
        count: data.count || 0
      };
    }
    return { services: [], has_expired: false, count: 0 };
  } catch (e) {
    console.error('Error cargando servicios:', e);
    return { services: [], has_expired: false, count: 0 };
  }
}

async function loadData() {
  try {
    const urlToken = getTokenFromURL();
    // Si hay token en la URL, guardarlo como token persistente
    if (urlToken) {
      localStorage.setItem('driveiq_last_token', urlToken);
      localStorage.setItem('driveiq_token', urlToken);
    }
    // Intentar token en este orden: URL → sesión → último guardado → login supervisor
    const token = urlToken
      || await getTokenFromSession()
      || localStorage.getItem('driveiq_last_token')
      || localStorage.getItem('driveiq_token');
    if (!token) {
      window.location.href = '/login.html';
      return;
    }
    USER_TOKEN = token;
    showLoading(true);

    // CARGAR CONFIGURACIÓN DESDE GPSWOX PRIMERO (CRÍTICO)
    await safeCallAsync(loadUserLanguage, false, token); // Idioma de la cuenta
    await safeCallAsync(loadUserUnits, false, token); // Unidades de medida (metric/imperial)
    await safeCallAsync(loadUserTimezone, false, token); // Timezone y formato de hora (12h/24h)
    await safeCallAsync(loadVehicleGroups, false, token); // Grupos de vehículos desde GPSWOX

    // Validar token
    const validation = await validateToken(token);
    if (!validation || !validation.valid) {
      // Token inválido o expirado — limpiar y redirigir al login
      localStorage.removeItem('driveiq_last_token');
      localStorage.removeItem('driveiq_token');
      window.location.href = '/login.html';
      return;
    }
    // Token válido — refrescar la copia guardada
    localStorage.setItem('driveiq_last_token', token);
    localStorage.setItem('driveiq_token', token);
    
    // ── Rango por defecto: últimos 7 días ────────────────────────────────
    const _today  = new Date();
    const _7ago   = new Date(_today); _7ago.setDate(_7ago.getDate() - 7);
    const _defFrom = _7ago.toISOString().split('T')[0];
    const _defTo   = _today.toISOString().split('T')[0];
    // Pre-llenar los inputs de fecha para que el usuario vea el rango cargado
    const _sdEl = document.getElementById('startDate');
    const _edEl = document.getElementById('endDate');
    if (_sdEl && !_sdEl.value) _sdEl.value = _defFrom;
    if (_edEl && !_edEl.value) _edEl.value = _defTo;

    // Cargar datos en paralelo
    console.log(`🔄 Iniciando carga de datos en paralelo...`);
    const [vehicles, drivers, events] = await Promise.all([
      loadVehicles(token),
      loadDrivers(token),
      loadEvents(token, _defFrom, _defTo)
    ]);
    
    console.log(`📊 Datos cargados: ${vehicles?.length || 0} vehículos, ${drivers?.length || 0} conductores, ${events?.length || 0} eventos`);
    console.log(`🔍 Verificación:`, {
      vehiclesIsArray: Array.isArray(vehicles),
      driversIsArray: Array.isArray(drivers),
      eventsIsArray: Array.isArray(events),
      vehiclesFirst: vehicles?.[0],
      driversFirst: drivers?.[0]
    });
    
    DATA = { vehicles: vehicles || [], drivers: drivers || [], events: events || [] };
    
    console.log(`✅ DATA inicializado:`, {
      vehiclesCount: DATA.vehicles.length,
      driversCount: DATA.drivers.length,
      eventsCount: DATA.events.length
    });
    
    // Cargar tipos de vehículos — primero del servidor, luego localStorage como fallback
    let savedTypes = null;
    let savedVehicleTypes = null;
    let _serverVT = {};
    try {
      const r = await fetch(`${API_BASE}/config/vehicle-types?token=${encodeURIComponent(USER_TOKEN)}`);
      if (r.ok) {
        const d = await r.json();
        if (d.status === 'ok') {
          _serverVT = d.vehicleTypes || d.types || {};
          if (Object.keys(d.types || {}).length > 0) savedTypes = JSON.stringify(d.types);
          if (Object.keys(d.vehicleTypes || {}).length > 0) savedVehicleTypes = JSON.stringify(d.vehicleTypes);
        }
      }
    } catch (_) {}
    // COSECHA no destructiva: si este navegador tiene tipos que el servidor aún no tiene
    // (asignados antes de la migración por-equipo), subirlos UNA vez. El backend solo
    // acepta equipos de esta flota y solo llena vacíos (no pisa). Así no se pierde nada.
    try {
      const _localVT = JSON.parse(localStorage.getItem('driveiq_vehicle_types_vehicles') || localStorage.getItem('driveiq_vehicle_types') || '{}');
      const _gaps = {};
      for (const k in _localVT) { if (_localVT[k] && !_serverVT[k]) _gaps[k] = _localVT[k]; }
      if (Object.keys(_gaps).length) {
        fetch(`${API_BASE}/config/vehicle-types`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: USER_TOKEN, vehicleTypes: _gaps, types: _gaps, harvest: true }) }).catch(() => {});
        const _merged = Object.assign({}, _gaps, _serverVT); // servidor manda sobre el gap
        savedTypes = JSON.stringify(_merged);
        savedVehicleTypes = JSON.stringify(_merged);
      }
    } catch (_) {}
    // Sincronizar localStorage (caché) con lo efectivo del servidor+cosecha
    if (savedTypes) localStorage.setItem('driveiq_vehicle_types', savedTypes);
    if (savedVehicleTypes) localStorage.setItem('driveiq_vehicle_types_vehicles', savedVehicleTypes);
    // Fallback final: si todo quedó vacío, usar localStorage tal cual (transición)
    if (!savedTypes) savedTypes = localStorage.getItem('driveiq_vehicle_types');
    if (!savedVehicleTypes) savedVehicleTypes = localStorage.getItem('driveiq_vehicle_types_vehicles');

    if (savedTypes) {
      try {
        const types = JSON.parse(savedTypes);
        DATA.drivers.forEach(d => { if (types[d.driver_id]) d.type = types[d.driver_id]; });
        _typesWereLoaded = true;
      } catch (e) { console.error('Error cargando tipos guardados:', e); }
    }
    if (savedVehicleTypes) {
      try {
        const vehicleTypes = JSON.parse(savedVehicleTypes);
        DATA.vehicles.forEach(v => { if (vehicleTypes[v.unit_id]) v.type = vehicleTypes[v.unit_id]; });
        _typesWereLoaded = true;
      } catch (e) { console.error('Error cargando tipos de vehículos guardados:', e); }
    }
    
    // También aplicar tipos desde conductores a vehículos
    DATA.vehicles.forEach(v => {
      const driver = DATA.drivers.find(d => d.unit_id === v.unit_id);
      if (driver && driver.type && !v.type) {
        if (driver.type === 'truck') v.type = 'camion';
        else if (driver.type === 'car') v.type = 'auto';
        else v.type = driver.type;
      }
    });
    
    if (events && events.length > 0 && DATA.drivers && DATA.drivers.length > 0) {
      DATA.drivers = calculateScores(DATA.drivers, events);
    }
  } catch (e) {
    console.error('Error cargando datos:', e);
    showError(t('error.loading'));
    DATA = { vehicles: [], drivers: [], events: [] };
  } finally {
    showLoading(false);
  }
  // Modo nocturno siempre activo (predeterminado)
  setTheme(localStorage.getItem('driveiq_theme') || 'light');
}

function calculateScores(drivers, events) {
  if (!drivers || !events) return drivers || [];
  const scores = {};
  
  // Inicializar scores solo para conductores con tipo asignado
  drivers.forEach(d => {
    if (!d.type || d.type === '') return; // sin tipo = no se mide
    scores[d.driver_id] = { driver: d, score: 100, events_count: 0 };
  });
  
  // Procesar cada evento con penalización ponderada por severidad y umbrales
  events.forEach(e => {
    const driverId = e.driver_id?.toString();
    if (!driverId || !scores[driverId]) return;
    
    const driver = scores[driverId].driver;
    scores[driverId].events_count++;
    
    // Obtener tipo de vehículo del conductor para aplicar umbrales
    const vehicleType = driver.type || 'auto';
    
    // Obtener umbrales configurables (WORKING_THRESHOLDS) o usar valores recomendados
    if (!WORKING_THRESHOLDS) {
      WORKING_THRESHOLDS = JSON.parse(JSON.stringify(RECOMMENDED));
    }
    
    const thresholds = WORKING_THRESHOLDS[vehicleType] || WORKING_THRESHOLDS.auto || RECOMMENDED.auto;
    
    // Determinar severidad si no viene en el evento (usando umbrales)
    let finalSeverity = e.severity || 'medio';
    
    // La severidad la calcula el BACKEND por tipo de vehículo (m/s², fuente única).
    // Solo se deriva aquí si por alguna razón el backend no la envió.
    if (!e.severity) {
      if (e.type === 'acceleration' || e.type === 'hard_acceleration') {
        // Intentar obtener valor de aceleración desde diferentes campos posibles
        const accelValue = e.acceleration || e.accel_value || e.additional?.accel || e.additional?.acceleration || e.value || e.g_force || 0;
        if (accelValue > 0 && thresholds && thresholds.accel) {
          const ratio = accelValue / thresholds.accel;
          // Clasificar según ratio: Leve (1.0-1.3x), Medio (1.3-1.6x), Fuerte (>1.6x)
          if (ratio >= 1.6) finalSeverity = 'fuerte';
          else if (ratio >= 1.3) finalSeverity = 'medio';
          else if (ratio >= 1.0) finalSeverity = 'leve';
        }
      } else if (e.type === 'braking' || e.type === 'hard_brake' || e.type === 'hard_braking') {
        // Intentar obtener valor de frenado desde diferentes campos posibles
        const brakeValue = e.braking || e.brake_value || e.additional?.brake || e.additional?.braking || e.deceleration || e.value || 0;
        if (brakeValue > 0 && thresholds && thresholds.braking) {
          const ratio = brakeValue / thresholds.braking;
          // Clasificar según ratio: Leve (1.0-1.3x), Medio (1.3-1.6x), Fuerte (>1.6x)
          if (ratio >= 1.6) finalSeverity = 'fuerte';
          else if (ratio >= 1.3) finalSeverity = 'medio';
          else if (ratio >= 1.0) finalSeverity = 'leve';
        }
      } else if (e.type === 'hard_turn' || e.type === 'corner' || e.type === 'hard_cornering') {
        // Intentar obtener valor de giro desde diferentes campos posibles
        const cornerValue = e.corner || e.corner_value || e.additional?.corner || e.additional?.cornering || e.lateral_g || e.turn_angle || e.value || 0;
        if (cornerValue > 0 && thresholds && thresholds.corner) {
          const ratio = cornerValue / thresholds.corner;
          // Clasificar según ratio: Leve (1.0-1.2x), Medio (1.2-1.5x), Fuerte (>1.5x)
          // Giros tienen umbrales ligeramente diferentes (más sensibles)
          if (ratio >= 1.5) finalSeverity = 'fuerte';
          else if (ratio >= 1.2) finalSeverity = 'medio';
          else if (ratio >= 1.0) finalSeverity = 'leve';
        }
      }
    }
    
    // PENALIZACIÓN PONDERADA POR SEVERIDAD (tipo Wialon)
    let basePenalty = 0;
    
    // Determinar base penalty según tipo de evento
    if (e.type === 'overspeed') {
      basePenalty = 5; // Exceso de velocidad tiene mayor impacto base
    } else if (e.type === 'acceleration' || e.type === 'hard_acceleration') {
      basePenalty = 3;
    } else if (e.type === 'braking' || e.type === 'hard_brake' || e.type === 'hard_braking') {
      basePenalty = 3;
    } else if (e.type === 'hard_turn' || e.type === 'corner' || e.type === 'hard_cornering') {
      basePenalty = 2;
    } else {
      basePenalty = 1; // Evento desconocido
    }
    
    // APLICAR MULTIPLICADOR POR SEVERIDAD
    // Leve = 0.5x, Media = 1.0x, Fuerte = 1.5x (modelo Wialon)
    let severityMultiplier = 1.0;
    const severity = (finalSeverity || 'medio').toLowerCase();
    
    if (severity === 'leve' || severity === 'light' || severity === 'low' || severity === 'bajo') {
      severityMultiplier = 0.5; // Bajo/Leve = mitad de penalización
    } else if (severity === 'fuerte' || severity === 'high' || severity === 'severe' || severity === 'hard' || severity === 'alto') {
      severityMultiplier = 1.5; // Alto/Fuerte = 50% más de penalización
    } else {
      severityMultiplier = 1.0; // Medio = normal
    }
    
    // Calcular penalización base
    let penalty = basePenalty * severityMultiplier;
    
    // APLICAR AJUSTE POR TIPO DE VEHÍCULO usando umbrales configurables
    // Vehículos con umbrales más bajos (más sensibles) = más penalización
    let vehicleMultiplier = 1.0;
    
    if (thresholds) {
      // Comparar umbral del vehículo vs umbral estándar (auto)
      const standardThresholds = (WORKING_THRESHOLDS && WORKING_THRESHOLDS.auto) || RECOMMENDED.auto;
      
      if (e.type === 'acceleration' || e.type === 'hard_acceleration') {
        // Si el umbral es más bajo, el vehículo es más sensible → más penalización
        const sensitivityRatio = standardThresholds.accel / thresholds.accel;
        vehicleMultiplier = 0.8 + (sensitivityRatio - 1) * 0.3; // Entre 0.8 y 1.3
      } else if (e.type === 'braking' || e.type === 'hard_brake') {
        const sensitivityRatio = standardThresholds.braking / thresholds.braking;
        vehicleMultiplier = 0.8 + (sensitivityRatio - 1) * 0.3;
      } else if (e.type === 'hard_turn' || e.type === 'corner') {
        const sensitivityRatio = standardThresholds.corner / thresholds.corner;
        vehicleMultiplier = 0.8 + (sensitivityRatio - 1) * 0.3;
      }
      
      // Asegurar multiplicador dentro de rango razonable
      vehicleMultiplier = Math.max(0.7, Math.min(1.3, vehicleMultiplier));
    } else {
      // Fallback: multiplicadores fijos si no hay umbrales
      if (vehicleType === 'truck' || vehicleType === 'camion') {
        vehicleMultiplier = 1.2; // Camiones: 20% más de penalización
      } else if (vehicleType === 'bus') {
        vehicleMultiplier = 1.1; // Buses: 10% más de penalización
      } else if (vehicleType === 'moto') {
        vehicleMultiplier = 0.9; // Motos: 10% menos de penalización
      }
    }
    
    // Penalización final ajustada por tipo de vehículo
    penalty = penalty * vehicleMultiplier;
    
    // Aplicar penalización (redondear a entero)
    scores[driverId].score = Math.max(0, scores[driverId].score - Math.round(penalty));
  });
  
  return drivers.map(d => {
    const scoreData = scores[d.driver_id] || { score: 100, events_count: 0 };
    return { ...d, score: scoreData.score, events_count: scoreData.events_count };
  });
}

// Calcular score para vehículo sin conductor (usando misma lógica que conductores con umbrales)
function calculateVehicleScore(vehicle, events) {
  if (!vehicle || !events || events.length === 0) return 100;
  
  let score = 100;
  
  // Obtener tipo de vehículo (puede estar en vehicle.type)
  const vehicleType = vehicle.type || 'auto';
  const typeForThresholds = (vehicleType === 'camion' ? 'truck' : vehicleType === 'auto' ? 'car' : vehicleType) || 'auto';
  
  // Obtener umbrales configurables (WORKING_THRESHOLDS) o usar valores recomendados
  if (!WORKING_THRESHOLDS) {
    WORKING_THRESHOLDS = JSON.parse(JSON.stringify(RECOMMENDED));
  }
  
  const thresholds = WORKING_THRESHOLDS[typeForThresholds] || WORKING_THRESHOLDS.auto || RECOMMENDED.auto;
  
  events.forEach(e => {
    // Determinar severidad si no viene (usando umbrales)
    let finalSeverity = e.severity || 'medio';
    
    // La severidad la calcula el BACKEND por tipo de vehículo (fuente única).
    if (!e.severity) {
      if (e.type === 'acceleration' || e.type === 'hard_acceleration') {
        const accelValue = e.acceleration || e.accel_value || e.additional?.accel || e.additional?.acceleration || e.value || e.g_force || 0;
        if (accelValue > 0 && thresholds && thresholds.accel) {
          const ratio = accelValue / thresholds.accel;
          if (ratio >= 1.6) finalSeverity = 'fuerte';
          else if (ratio >= 1.3) finalSeverity = 'medio';
          else if (ratio >= 1.0) finalSeverity = 'leve';
        }
      } else if (e.type === 'braking' || e.type === 'hard_brake' || e.type === 'hard_braking') {
        const brakeValue = e.braking || e.brake_value || e.additional?.brake || e.additional?.braking || e.deceleration || e.value || 0;
        if (brakeValue > 0 && thresholds && thresholds.braking) {
          const ratio = brakeValue / thresholds.braking;
          if (ratio >= 1.6) finalSeverity = 'fuerte';
          else if (ratio >= 1.3) finalSeverity = 'medio';
          else if (ratio >= 1.0) finalSeverity = 'leve';
        }
      } else if (e.type === 'hard_turn' || e.type === 'corner' || e.type === 'hard_cornering') {
        const cornerValue = e.corner || e.corner_value || e.additional?.corner || e.additional?.cornering || e.lateral_g || e.turn_angle || e.value || 0;
        if (cornerValue > 0 && thresholds && thresholds.corner) {
          const ratio = cornerValue / thresholds.corner;
          if (ratio >= 1.5) finalSeverity = 'fuerte';
          else if (ratio >= 1.2) finalSeverity = 'medio';
          else if (ratio >= 1.0) finalSeverity = 'leve';
        }
      }
    }
    
    // PENALIZACIÓN PONDERADA POR SEVERIDAD (misma lógica que calculateScores)
    let basePenalty = 0;
    
    if (e.type === 'overspeed') {
      basePenalty = 5;
    } else if (e.type === 'acceleration' || e.type === 'hard_acceleration') {
      basePenalty = 3;
    } else if (e.type === 'braking' || e.type === 'hard_brake' || e.type === 'hard_braking') {
      basePenalty = 3;
    } else if (e.type === 'hard_turn' || e.type === 'corner' || e.type === 'hard_cornering') {
      basePenalty = 2;
    } else {
      basePenalty = 1;
    }
    
    // Multiplicador por severidad
    let severityMultiplier = 1.0;
    const severity = (finalSeverity || 'medio').toLowerCase();
    if (severity === 'leve' || severity === 'light' || severity === 'low' || severity === 'bajo') {
      severityMultiplier = 0.5;
    } else if (severity === 'fuerte' || severity === 'high' || severity === 'severe' || severity === 'hard' || severity === 'alto') {
      severityMultiplier = 1.5;
    }
    
    let penalty = basePenalty * severityMultiplier;
    
    // Ajuste por tipo de vehículo usando umbrales
    if (thresholds) {
      const standardThresholds = (WORKING_THRESHOLDS && WORKING_THRESHOLDS.auto) || RECOMMENDED.auto;
      let vehicleMultiplier = 1.0;
      
      if (e.type === 'acceleration' || e.type === 'hard_acceleration') {
        const sensitivityRatio = standardThresholds.accel / thresholds.accel;
        vehicleMultiplier = 0.8 + (sensitivityRatio - 1) * 0.3;
      } else if (e.type === 'braking' || e.type === 'hard_brake') {
        const sensitivityRatio = standardThresholds.braking / thresholds.braking;
        vehicleMultiplier = 0.8 + (sensitivityRatio - 1) * 0.3;
      } else if (e.type === 'hard_turn' || e.type === 'corner') {
        const sensitivityRatio = standardThresholds.corner / thresholds.corner;
        vehicleMultiplier = 0.8 + (sensitivityRatio - 1) * 0.3;
      }
      
      vehicleMultiplier = Math.max(0.7, Math.min(1.3, vehicleMultiplier));
      penalty = penalty * vehicleMultiplier;
    } else {
      // Fallback: multiplicadores fijos
      if (vehicleType === 'truck' || vehicleType === 'camion') {
        penalty *= 1.2;
      } else if (vehicleType === 'bus') {
        penalty *= 1.1;
      } else if (vehicleType === 'moto') {
        penalty *= 0.9;
      }
    }
    
    score = Math.max(0, score - Math.round(penalty));
  });
  
  return score;
}

const DIQ_LOADER_MSGS = [
  'Estamos cargando sus datos',
  'Analizando eventos de conducción…',
  'Son muchos datos, un momento más',
  'Procesando rutas de su flota…',
  'Calculando puntajes de rendimiento…',
  'Verificando alertas activas…',
  'Casi listo, preparando su panel…',
];
let _diqMsgTimer = null;

function showLoading(show) {
  if (!show) {
    // Ocultar ambos loaders
    if (_diqMsgTimer) { clearInterval(_diqMsgTimer); _diqMsgTimer = null; }
    const staticLoader = document.getElementById('diq-static-loader');
    if (staticLoader) {
      staticLoader.style.opacity = '0';
      staticLoader.style.transition = 'opacity 0.35s ease';
      setTimeout(() => { if (staticLoader.parentNode) staticLoader.remove(); }, 380);
    }
    const existing = document.getElementById('driveiqLoader');
    if (existing) existing.remove();
    return;
  }
  // show=true: solo usar el loader estático del HTML (fondo negro)
  // NO crear el loader animado naranja
  if (document.getElementById('driveiqLoader')) return;
  // Si el estático ya fue removido, recrearlo simplemente
  if (!document.getElementById('diq-static-loader')) return;

  // loader naranja desactivado — se usa solo el loader estático de fondo negro
}

function showError(msg) {
  const existing = document.getElementById('errorAlert');
  if (existing) existing.remove();
  const alert = document.createElement('div');
  alert.id = 'errorAlert';
  alert.className = 'alert alert-danger alert-dismissible fade show';
  alert.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;max-width:400px;background:#121F36;border:1px solid #F85149;color:#E6EDF3;';
  alert.innerHTML = `<strong>Error:</strong> ${msg}<button type="button" class="btn-close" data-bs-dismiss="alert" style="filter:invert(1);"></button>`;
  document.body.appendChild(alert);
  setTimeout(() => {
    if (alert.parentNode) alert.remove();
  }, 5000);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('🚀 DriveIQ iniciando...');

    // Mostrar pantalla de carga inmediatamente, antes de cualquier otra cosa
    showLoading(true);

    // Cargar i18n básico primero (fallback español)
    await safeCallAsync(loadI18n, null, 'es');
    updateBranding();
    updateTableHeaders();

    initUI();
    // Cargar umbrales guardados (localStorage primero, luego API)
    // Siempre se fusiona con RECOMMENDED para incluir tipos nuevos
    WORKING_THRESHOLDS = JSON.parse(JSON.stringify(RECOMMENDED));
    try {
      // Umbrales efectivos del tenant desde el backend (fuente única, m/s²).
      const rt = await fetch(`${API_BASE}/config/thresholds?token=${encodeURIComponent(USER_TOKEN)}`);
      if (rt.ok) { const dt = await rt.json(); if (dt.status === 'ok' && dt.thresholds) WORKING_THRESHOLDS = dt.thresholds; }
    } catch(e) { /* usa RECOMMENDED si hay error */ }

    await loadData();

    if (DATA && DATA.drivers && DATA.vehicles) {
      try {
        renderInitialState();
      } catch (renderErr) {
        console.error('❌ Error en renderInitialState:', renderErr);
        console.error('Stack:', renderErr.stack);
        showError('Error al renderizar la interfaz: ' + renderErr.message);
      }
    } else {
      showError(t('error.no_data'));
    }

    console.log('✅ DriveIQ cargado correctamente');
  } catch (e) {
    console.error('❌ Error crítico en DOMContentLoaded:', e);
    console.error('Stack:', e.stack);
    // Mostrar error al usuario
    const body = document.body;
    if (body) {
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'padding: 40px; text-align: center; font-family: Arial, sans-serif; background: #0B1220; color: #E6EDF3; min-height: 100vh;';
      errorDiv.innerHTML = `
        <h1 style="color: #F85149;">Error al cargar DriveIQ</h1>
        <p style="color: #8B949E;">Por favor, recarga la página o contacta al soporte.</p>
        <p style="color: #6B7280; font-size: 12px; margin-top: 20px;">Error: ${e.message}</p>
        <pre style="color: #6B7280; font-size: 11px; margin-top: 10px; text-align:left; max-width:800px; margin:10px auto; overflow:auto;">${(e.stack||'').replace(/</g,'&lt;')}</pre>
        <button onclick="location.reload()" style="margin-top: 20px; padding: 10px 20px; background: #2F81F7; color: white; border: none; border-radius: 6px; cursor: pointer;">Recargar página</button>
      `;
      body.innerHTML = '';
      body.appendChild(errorDiv);
    }
  }
});

function initUI() {
  try {
    offcanvas = new bootstrap.Offcanvas(document.getElementById('driverDetail'));
  } catch (e) {
    console.error('Error inicializando offcanvas:', e);
  }
  // Cargar tema guardado o usar modo nocturno por defecto
  const savedTheme = localStorage.getItem('driveiq_theme') || 'light';
  setTheme(savedTheme);
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      setTheme(newTheme);
    });
  }
  const openAssignTypes = document.getElementById('openAssignTypes');
  if (openAssignTypes) openAssignTypes.addEventListener('click', () => openAssignModal());
  const saveAssignBtn = document.getElementById('saveAssign');
  if (saveAssignBtn) saveAssignBtn.addEventListener('click', saveAssign);
  const openThresholdsBtn = document.getElementById('openThresholds');
  if (openThresholdsBtn) {
    openThresholdsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openThresholds();
      new bootstrap.Modal(document.getElementById('modalThresholds')).show();
    });
  }
  const saveThresholdsBtn = document.getElementById('saveThresholds');
  if (saveThresholdsBtn) saveThresholdsBtn.addEventListener('click', saveThresholds);
  const loadRecommended = document.getElementById('loadRecommended');
  if (loadRecommended) {
    loadRecommended.addEventListener('click', () => {
      WORKING_THRESHOLDS = JSON.parse(JSON.stringify(RECOMMENDED));
      openThresholds();
    });
  }
  const openProfilesBtn = document.getElementById('openProfiles');
  if (openProfilesBtn) openProfilesBtn.addEventListener('click', openProfiles);
  const runCalibBtn = document.getElementById('runCalibration');
  if (runCalibBtn) runCalibBtn.addEventListener('click', runFleetCalibration);
  const applyCalibBtn = document.getElementById('applyCalibration');
  if (applyCalibBtn) applyCalibBtn.addEventListener('click', applySelectedCalibration);
  // btnGenerate vive ahora en el modal — se enlaza via event delegation
  document.addEventListener('click', e => {
    if (e.target.closest('#btnGenerate')) generateReport();
  });
  document.querySelectorAll('.report-btn').forEach(b => b.addEventListener('click', (e) => toggleReportButton(e.target)));
  // Los event listeners de checkboxes se agregan en populateFilters()
  // No necesitamos listeners adicionales aquí
  const startDate = document.getElementById('startDate');
  if (startDate) {
    startDate.addEventListener('change', async () => {
      await reloadEventsWithFilters();
      applyFilters();
    });
  }
  const endDate = document.getElementById('endDate');
  if (endDate) {
    endDate.addEventListener('change', async () => {
      await reloadEventsWithFilters();
      applyFilters();
    });
  }
  const quickRange = document.getElementById('quickRange');
  if (quickRange) {
    quickRange.addEventListener('change', async (e) => {
      await applyQuickRange(e.target.value);
      await reloadEventsWithFilters();
      applyFilters();
    });
  }
  const downloadPdf = document.getElementById('downloadPdf');
  if (downloadPdf) {
    downloadPdf.addEventListener('click', () => {
      if (currentDriverId) downloadDriverPdf(currentDriverId);
    });
  }
  const downloadXls = document.getElementById('downloadXls');
  if (downloadXls) {
    downloadXls.addEventListener('click', () => {
      if (currentDriverId) downloadDriverXls(currentDriverId);
    });
  }
  const downloadCsv = document.getElementById('downloadCsv');
  if (downloadCsv) {
    downloadCsv.addEventListener('click', () => {
      if (currentDriverId) downloadDriverCsv(currentDriverId);
    });
  }
  const downloadJson = document.getElementById('downloadJson');
  if (downloadJson) {
    downloadJson.addEventListener('click', () => {
      if (currentDriverId) downloadDriverJson(currentDriverId);
    });
  }
  const downloadHtml = document.getElementById('downloadHtml');
  if (downloadHtml) {
    downloadHtml.addEventListener('click', () => {
      if (currentDriverId) downloadDriverHtml(currentDriverId);
    });
  }
  
  // Inicializar selector de ranking
  initRankingSelector();
}

function initRankingSelector() {
  const scoreHeader = document.getElementById('scoreHeader');
  if (!scoreHeader) return;
  
  scoreHeader.addEventListener('click', (e) => {
    e.stopPropagation();
    showRankingMenu(e.target);
  });
  
  // Actualizar texto del header según el orden actual
  updateScoreHeaderText();
}

function updateScoreHeaderText() {
  const scoreHeader = document.getElementById('scoreHeader');
  if (!scoreHeader) return;
  
  const orderText = RANKING_ORDER === 'asc' ? 'Peor → Mejor' : 'Mejor → Peor';
  const filterText = RANKING_MAX_SCORE < 100 ? ` ≤ ${RANKING_MAX_SCORE}` : '';
  scoreHeader.innerHTML = `Puntuación <span class="score-header-arrow">▼</span><br><small class="score-header-subtitle">${orderText}${filterText}</small>`;
}

function showRankingMenu(element) {
  // Cerrar menú existente si hay uno
  const existingMenu = document.getElementById('rankingMenu');
  if (existingMenu) {
    existingMenu.remove();
    return;
  }
  
  // Crear menú contextual
  const menu = document.createElement('div');
  menu.id = 'rankingMenu';
  menu.className = 'ranking-menu';
  
  const orderText = RANKING_ORDER === 'asc' ? 'Peor → Mejor' : 'Mejor → Peor';
  const filterText = RANKING_MAX_SCORE < 100 ? `Solo ≤ ${RANKING_MAX_SCORE}` : 'Todos';
  
  menu.innerHTML = `
    <div class="ranking-menu-title">Ordenar por puntuación</div>
    <div class="ranking-menu-item ${RANKING_ORDER === 'asc' ? 'active' : ''}" data-order="asc">
      ${RANKING_ORDER === 'asc' ? '✓' : ''} Peor → Mejor
    </div>
    <div class="ranking-menu-item ${RANKING_ORDER === 'desc' ? 'active' : ''}" data-order="desc">
      ${RANKING_ORDER === 'desc' ? '✓' : ''} Mejor → Peor
    </div>
    <div class="ranking-menu-divider"></div>
    <div class="ranking-menu-title">Filtro por score</div>
    <div class="ranking-menu-item ${RANKING_MAX_SCORE === 40 ? 'active' : ''}" data-filter="40">
      ${RANKING_MAX_SCORE === 40 ? '✓' : ''} Críticos (≤ 40)
    </div>
    <div class="ranking-menu-item ${RANKING_MAX_SCORE === 60 ? 'active' : ''}" data-filter="60">
      ${RANKING_MAX_SCORE === 60 ? '✓' : ''} En riesgo (≤ 60)
    </div>
    <div class="ranking-menu-item ${RANKING_MAX_SCORE === 80 ? 'active' : ''}" data-filter="80">
      ${RANKING_MAX_SCORE === 80 ? '✓' : ''} A mejorar (≤ 80)
    </div>
    <div class="ranking-menu-item ${RANKING_MAX_SCORE === 100 ? 'active' : ''}" data-filter="100">
      ${RANKING_MAX_SCORE === 100 ? '✓' : ''} Todos
    </div>
  `;
  
  // Posicionar menú cerca del header — alineado a la derecha si no hay espacio
  const rect = element.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 5) + 'px';
  menu.style.zIndex = '1000';
  document.body.appendChild(menu);
  const menuW = menu.offsetWidth || 200;
  if (rect.left + menuW > window.innerWidth - 8) {
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.style.left = 'auto';
  } else {
    menu.style.left = rect.left + 'px';
  }
  
  // Event listeners para opciones
  menu.querySelectorAll('[data-order]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      RANKING_ORDER = item.getAttribute('data-order');
      updateScoreHeaderText();
      renderDriversTable();
      menu.remove();
    });
  });
  
  menu.querySelectorAll('[data-filter]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      RANKING_MAX_SCORE = parseInt(item.getAttribute('data-filter'));
      updateScoreHeaderText();
      renderDriversTable();
      menu.remove();
    });
  });
  
  // Cerrar menú al hacer clic fuera
  setTimeout(() => {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }, { once: true });
  }, 100);
}

function setTheme(theme) {
  try {
    const validTheme = (theme === 'dark' || theme === 'light') ? theme : 'dark';
    // Deshabilitar transiciones durante el cambio para evitar lag con muchos elementos
    document.documentElement.classList.add('theme-switching');
    document.body.classList.add('theme-switching');
    
    // Aplicar tema al HTML y body
    if (document.documentElement) {
      document.documentElement.setAttribute('data-theme', validTheme);
    }
    if (document.body) {
      document.body.setAttribute('data-theme', validTheme);
    }
    
    // Guardar en localStorage
    localStorage.setItem('driveiq_theme', validTheme);
    
    // Actualizar icono y label del botón de tema
    const icon = document.getElementById('themeIcon');
    const label = document.getElementById('themeLabel') || document.querySelector('.theme-label');
    
    if (icon) {
      // En modo dark mostramos sol (para cambiar a light), en light mostramos luna (para cambiar a dark)
      icon.textContent = validTheme === 'dark' ? '☀️' : '🌙';
    }
    if (label) {
      // El label muestra el modo AL QUE SE CAMBIARÁ al hacer clic, no el actual
      // Si estamos en dark, el botón debe decir "Modo claro" (porque al hacer clic cambiará a light)
      // Si estamos en light, el botón debe decir "Modo oscuro" (porque al hacer clic cambiará a dark)
      const targetMode = validTheme === 'dark' ? 'light' : 'dark';
      label.textContent = targetMode === 'light' ? (t('light_mode') || 'Modo claro') : (t('dark_mode') || 'Modo oscuro');
    }
    
    // Actualizar encabezado "Trip" a "Viaje" traducido
    if (typeof updateTableHeaders === 'function') {
      updateTableHeaders();
    }
    
    // Re-habilitar transiciones en el próximo frame (instantáneo para el usuario)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.documentElement.classList.remove('theme-switching');
      document.body.classList.remove('theme-switching');
    }));

    console.log(`🎨 Tema cambiado a: ${validTheme}`);
  } catch (e) {
    console.error('Error en setTheme:', e);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderInitialState() {
  if (!DATA || !DATA.drivers || !DATA.vehicles) {
    console.error('DATA no está inicializado');
    return;
  }
  
  // Inicializar filtros: seleccionar todos por defecto
  if (typeof selectedVehicles === 'undefined') {
    selectedVehicles = new Set();
  }
  if (typeof selectedDrivers === 'undefined') {
    selectedDrivers = new Set();
  }
  
  selectedVehicles.clear();
  selectedDrivers.clear();
  DATA.vehicles.forEach(v => selectedVehicles.add(v.unit_id));
  DATA.drivers.forEach(d => selectedDrivers.add(d.driver_id));
  
  populateFilters();
  renderAssignTable();
  typesSaved = _typesWereLoaded;
  // Siempre renderizar — si no hay tipos asignados los vehículos aparecen en sección pendientes
  renderAll();
  // Traducir el contenido recién renderizado (en/pt; no-op en es).
  translateDOM(document.body);
}

function populateFilters() {
  if (!DATA || !DATA.drivers || !DATA.vehicles) {
    console.error('DATA no está inicializado en populateFilters');
    return;
  }
  
  // Verificar que los contenedores existan antes de intentar poblar
  const vehicleContainer = document.getElementById('filterVehicleContainer');
  const driverContainer = document.getElementById('filterDriverContainer');
  
  // Si no existen los contenedores nuevos, puede ser que el HTML aún tenga los selects antiguos
  // En ese caso, no hacer nada (compatibilidad hacia atrás)
  if (!vehicleContainer || !driverContainer) {
    console.warn('populateFilters: Contenedores de checkboxes no encontrados. Puede que el HTML aún use selects.');
    return;
  }
  
  // POBLAR FILTRO DE VEHÍCULOS CON CHECKBOXES
  try {
    populateVehicleFilters();
  } catch (e) {
    console.error('Error en populateVehicleFilters:', e);
  }
  
  // POBLAR FILTRO DE CONDUCTORES CON CHECKBOXES
  try {
    populateDriverFilters();
  } catch (e) {
    console.error('Error en populateDriverFilters:', e);
  }
}

function populateVehicleFilters() {
  try {
    const groupsContainer = document.getElementById('vehicleGroupsContainer');
    const selectAllCheckbox = document.getElementById('selectAllVehicles');
    const selectAllLabel = document.getElementById('selectAllVehiclesLabel');
    const countBadge = document.getElementById('vehicleSelectionCount');
    const searchInput = document.getElementById('vehicleSearch');
    if (!groupsContainer) return;
    groupsContainer.innerHTML = '';

    if (selectAllLabel) selectAllLabel.textContent = t('select_all') || 'Todos los vehículos';

    function updateCount() {
      if (countBadge) countBadge.textContent = `${selectedVehicles.size} / ${DATA.vehicles.length}`;
      if (selectAllCheckbox) selectAllCheckbox.checked = selectedVehicles.size === DATA.vehicles.length && DATA.vehicles.length > 0;
    }

    // Construir mapa grupo → vehículos
    const vehicleById = {};
    DATA.vehicles.forEach(v => { vehicleById[v.unit_id] = v; });

    const assignedVehicleIds = new Set();
    const groupDefs = [];

    (VEHICLE_GROUPS || []).forEach(group => {
      const ids = (group.vehicle_ids || []).map(String);
      const vehs = ids.map(id => vehicleById[id]).filter(Boolean);
      ids.forEach(id => assignedVehicleIds.add(id));
      if (vehs.length > 0) groupDefs.push({ name: group.name, id: group.id, vehicles: vehs });
    });

    const ungrouped = DATA.vehicles.filter(v => !assignedVehicleIds.has(String(v.unit_id)));
    if (ungrouped.length > 0) groupDefs.push({ name: 'Sin grupo', id: '__ungrouped__', vehicles: ungrouped });

    // Renderizar cada grupo
    groupDefs.forEach((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'fvg-group'; // collapsed by default

      const allSelected = group.vehicles.every(v => selectedVehicles.has(v.unit_id));
      const someSelected = group.vehicles.some(v => selectedVehicles.has(v.unit_id));

      const header = document.createElement('div');
      header.className = 'fvg-group-header';
      header.innerHTML = `
        <span class="fvg-toggle">▶</span>
        <input type="checkbox" class="filter-checkbox fvg-group-check" ${allSelected ? 'checked' : ''}>
        <span class="fvg-group-name">${group.name}</span>
        <span class="fvg-group-badge">${group.vehicles.length}</span>
      `;

      const groupCheck = header.querySelector('.fvg-group-check');
      if (someSelected && !allSelected) groupCheck.indeterminate = true;

      const vehicleList = document.createElement('div');
      vehicleList.className = 'fvg-vehicles';

      group.vehicles.forEach(v => {
        const item = document.createElement('div');
        item.className = 'fvg-vehicle-item';
        item.dataset.name = formatVehicleName(v).toLowerCase();
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'filter-checkbox';
        cb.style.cssText = 'width:13px;height:13px;cursor:pointer;accent-color:#F97316;flex-shrink:0;';
        cb.checked = selectedVehicles.has(v.unit_id);
        cb.dataset.vehicleId = v.unit_id;

        cb.addEventListener('change', () => {
          if (cb.checked) selectedVehicles.add(v.unit_id); else selectedVehicles.delete(v.unit_id);
          const allNow = group.vehicles.every(vv => selectedVehicles.has(vv.unit_id));
          const someNow = group.vehicles.some(vv => selectedVehicles.has(vv.unit_id));
          groupCheck.checked = allNow;
          groupCheck.indeterminate = someNow && !allNow;
          updateCount();
          applyFilters();
        });

        const label = document.createElement('span');
        label.textContent = formatVehicleName(v);
        item.appendChild(cb);
        item.appendChild(label);
        vehicleList.appendChild(item);
      });

      // Toggle colapsar/expandir
      header.addEventListener('click', (e) => {
        if (e.target === groupCheck) return; // click en checkbox no colapsa
        groupEl.classList.toggle('expanded');
      });

      // Checkbox del grupo
      groupCheck.addEventListener('change', (e) => {
        e.stopPropagation();
        const checked = groupCheck.checked;
        groupCheck.indeterminate = false;
        group.vehicles.forEach(v => {
          if (checked) selectedVehicles.add(v.unit_id); else selectedVehicles.delete(v.unit_id);
          const cb = vehicleList.querySelector(`[data-vehicle-id="${v.unit_id}"]`);
          if (cb) cb.checked = checked;
        });
        updateCount();
        applyFilters();
      });

      groupEl.appendChild(header);
      groupEl.appendChild(vehicleList);
      groupsContainer.appendChild(groupEl);
    });

    // Buscador
    if (searchInput) {
      const newSearch = searchInput.cloneNode(true);
      searchInput.parentNode.replaceChild(newSearch, searchInput);
      newSearch.value = '';
      newSearch.addEventListener('input', () => {
        const q = newSearch.value.trim().toLowerCase();
        groupsContainer.querySelectorAll('.fvg-group').forEach(groupEl => {
          const items = groupEl.querySelectorAll('.fvg-vehicle-item');
          let visibleCount = 0;
          items.forEach(item => {
            const match = !q || item.dataset.name.includes(q);
            item.classList.toggle('hidden', !match);
            if (match) visibleCount++;
          });
          const hidden = visibleCount === 0 && q;
          groupEl.classList.toggle('search-hidden', hidden);
          if (q && visibleCount > 0) groupEl.classList.add('expanded');
        });
      });
    }

    // Seleccionar todos
    if (selectAllCheckbox) {
      const newCb = selectAllCheckbox.cloneNode(true);
      selectAllCheckbox.parentNode.replaceChild(newCb, selectAllCheckbox);
      newCb.checked = selectedVehicles.size === DATA.vehicles.length && DATA.vehicles.length > 0;
      newCb.addEventListener('change', () => {
        const checked = newCb.checked;
        selectedVehicles.clear();
        if (checked) DATA.vehicles.forEach(v => selectedVehicles.add(v.unit_id));
        // Actualizar todos los checkboxes
        groupsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = checked; cb.indeterminate = false; });
        updateCount();
        applyFilters();
      });
    }

    updateCount();
  } catch(e) {
    console.error('Error en populateVehicleFilters:', e);
  }
}

function populateDriverFilters() {
  try {
    const container = document.getElementById('driverListContainer');
    const selectAllCheckbox = document.getElementById('selectAllDrivers');
    const selectAllLabel = document.getElementById('selectAllDriversLabel');
    
    // Si no existe el contenedor, puede ser que aún no se haya cargado el HTML
    if (!container) {
      const parentContainer = document.getElementById('filterDriverContainer');
      if (!parentContainer) {
        console.warn('populateDriverFilters: No se encontró el contenedor de filtros de conductores');
        return;
      }
      // Crear el contenedor si no existe
      const newContainer = document.createElement('div');
      newContainer.id = 'driverListContainer';
      newContainer.className = 'filter-list-container';
      parentContainer.appendChild(newContainer);
      return populateDriverFilters(); // Reintentar
    }
    
    container.innerHTML = '';
    
    // Actualizar label "Seleccionar todos"
    if (selectAllLabel) {
      selectAllLabel.textContent = t('select_all');
    }
    
    // Renderizar lista de conductores
    DATA.drivers.forEach(d => {
      const label = document.createElement('label');
      label.className = 'filter-checkbox-item';
      
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'filter-checkbox driver-checkbox';
      checkbox.value = d.driver_id;
      checkbox.dataset.driverId = d.driver_id;
      checkbox.checked = selectedDrivers.has(d.driver_id);
      checkbox.addEventListener('change', handleDriverCheckboxChange);
      
      const span = document.createElement('span');
      span.textContent = d.name;
      
      label.appendChild(checkbox);
      label.appendChild(span);
      container.appendChild(label);
    });
    
    // Manejar "Seleccionar todos"
    if (selectAllCheckbox) {
      // Remover listeners anteriores para evitar duplicados
      const newCheckbox = selectAllCheckbox.cloneNode(true);
      selectAllCheckbox.parentNode.replaceChild(newCheckbox, selectAllCheckbox);
      
      newCheckbox.checked = selectedDrivers.size === DATA.drivers.length && DATA.drivers.length > 0;
      newCheckbox.addEventListener('change', (e) => {
        const checked = e.target.checked;
        selectedDrivers.clear();
        if (checked) {
          DATA.drivers.forEach(d => selectedDrivers.add(d.driver_id));
        }
        // Actualizar todos los checkboxes
        container.querySelectorAll('.driver-checkbox').forEach(cb => {
          cb.checked = checked;
        });
        applyFilters();
      });
    }
  } catch (e) {
    console.error('Error en populateDriverFilters:', e);
  }
}

function handleVehicleCheckboxChange(e) {
  const vehicleId = e.target.value;
  if (e.target.checked) {
    selectedVehicles.add(vehicleId);
  } else {
    selectedVehicles.delete(vehicleId);
  }
  
  // Actualizar "Seleccionar todos"
  const selectAllCheckbox = document.getElementById('selectAllVehicles');
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = selectedVehicles.size === DATA.vehicles.length && DATA.vehicles.length > 0;
  }
  
  // Actualizar estado de checkboxes de grupos si el vehículo pertenece a algún grupo
  if (VEHICLE_GROUPS && VEHICLE_GROUPS.length > 0) {
    VEHICLE_GROUPS.forEach(group => {
      if (group.vehicle_ids && group.vehicle_ids.includes(vehicleId)) {
        const groupCheckbox = document.querySelector(`.group-checkbox[data-group-id="${group.id || group.name}"]`);
        if (groupCheckbox) {
          const allGroupSelected = group.vehicle_ids.every(id => selectedVehicles.has(id));
          groupCheckbox.checked = allGroupSelected;
        }
      }
    });
  }
  
  applyFilters();
}

function handleDriverCheckboxChange(e) {
  const driverId = e.target.value;
  if (e.target.checked) {
    selectedDrivers.add(driverId);
  } else {
    selectedDrivers.delete(driverId);
  }
  
  // Actualizar "Seleccionar todos"
  const selectAllCheckbox = document.getElementById('selectAllDrivers');
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = selectedDrivers.size === DATA.drivers.length && DATA.drivers.length > 0;
  }
  
  applyFilters();
}

function renderAssignTable() {
  const tbody = document.querySelector('#assignTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const ASN_ICONS = {
    car:        `<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4,16 L4,13 L9,9 L15,7 L33,7 L38,10 L43,13 L44,16 L4,16"/><line x1="15" y1="7" x2="13" y2="16"/><line x1="33" y1="7" x2="35" y2="16"/><circle cx="12" cy="19" r="3"/><circle cx="36" cy="19" r="3"/></svg>`,
    camioneta:  `<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4,16 L4,11 L8,7 L14,5 L26,5 L27,8 L27,16"/><path d="M27,16 L27,10 L44,10 L44,16 L4,16"/><line x1="14" y1="5" x2="12" y2="16"/><line x1="26" y1="5" x2="26" y2="16"/><circle cx="11" cy="19" r="3"/><circle cx="37" cy="19" r="3"/></svg>`,
    truck:      `<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3,17 L3,9 L6,5 L14,3 L18,3 L18,17 L3,17"/><rect x="18" y="3" width="27" height="14" rx="1"/><circle cx="9" cy="20" r="2.5"/><circle cx="27" cy="20" r="2.5"/><circle cx="38" cy="20" r="2.5"/></svg>`,
    minibus:    `<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3,17 L3,8 L6,6 L42,6 L45,8 L45,17 L3,17"/><rect x="6" y="8" width="7" height="4" rx="1"/><rect x="16" y="8" width="7" height="4" rx="1"/><rect x="26" y="8" width="7" height="4" rx="1"/><rect x="36" y="8" width="6" height="4" rx="1"/><circle cx="11" cy="20" r="3"/><circle cx="37" cy="20" r="3"/></svg>`,
    bus:        `<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="44" height="13" rx="2"/><rect x="6" y="6" width="7" height="5" rx="1"/><rect x="16" y="6" width="7" height="5" rx="1"/><rect x="26" y="6" width="7" height="5" rx="1"/><rect x="36" y="6" width="7" height="5" rx="1"/><circle cx="10" cy="20" r="3"/><circle cx="38" cy="20" r="3"/></svg>`,
    tractomula: `<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2,17 L2,10 L4,7 L9,4 L16,4 L18,6 L19,17"/><line x1="5" y1="11" x2="7" y2="7"/><line x1="7" y1="7" x2="14" y2="7"/><line x1="14" y1="7" x2="14" y2="11"/><rect x="20" y="6" width="26" height="11"/><circle cx="8" cy="20" r="2.5"/><circle cx="27" cy="20" r="2.5"/><circle cx="36" cy="20" r="2.5"/><circle cx="44" cy="20" r="2.5"/></svg>`,
    moto:       `<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="17" r="4.5"/><circle cx="40" cy="17" r="4.5"/><path d="M12,17 L17,11 L24,8 L31,11 L35,17"/><line x1="31" y1="11" x2="35" y2="13"/><line x1="8" y1="13" x2="17" y2="11"/><path d="M27,7 L33,6 L34,4"/></svg>`
  };
  // Labels usan nombres personalizados de Umbrales si el usuario los cambió
  const ASN_LABELS = {
    car:        VEHICLE_CUSTOM_NAMES.auto        || 'Auto',
    camioneta:  VEHICLE_CUSTOM_NAMES.camioneta   || 'Camioneta',
    truck:      VEHICLE_CUSTOM_NAMES.camion      || 'Camión',
    minibus:    VEHICLE_CUSTOM_NAMES.minibus     || 'Minibús',
    bus:        VEHICLE_CUSTOM_NAMES.bus         || 'Bus',
    tractomula: VEHICLE_CUSTOM_NAMES.tractomula  || 'Tractomula',
    moto:       VEHICLE_CUSTOM_NAMES.moto        || 'Moto'
  };
  const typeOptions = (sel) => Object.entries(ASN_LABELS).map(([v,l]) => `<option value="${v}"${sel===v?' selected':''}>${l}</option>`).join('');

  let assignedCount = 0;
  const total = DATA.vehicles.length;

  DATA.vehicles.forEach(veh => {
    const driver = DATA.drivers.find(d => d.unit_id === veh.unit_id);
    const vehicleName = formatVehicleName(veh);
    const driverId = driver ? driver.driver_id : ('vehicle_' + veh.unit_id);

    let selected = driver?.type || '';
    if (!selected) {
      const vt = veh.type || '';
      if (vt === 'auto' || vt === 'car') selected = 'car';
      else if (vt === 'camioneta') selected = 'camioneta';
      else if (vt === 'camion' || vt === 'truck') selected = 'truck';
      else if (vt === 'minibus') selected = 'minibus';
      else if (vt === 'bus') selected = 'bus';
      else if (vt === 'tractomula') selected = 'tractomula';
      else if (vt === 'moto') selected = 'moto';
    }
    if (selected) assignedCount++;

    const icon = selected && ASN_ICONS[selected]
      ? `<span class="asn-vtype-badge">${ASN_ICONS[selected]}<span class="asn-vtype-label">${ASN_LABELS[selected]}</span></span>`
      : '';

    const selClass = selected ? 'asn-type-sel asn-sel-assigned assign-type' : 'asn-type-sel assign-type';
    const typeSelect = `<select class="${selClass}" data-driver="${driverId}" data-vehicle="${veh.unit_id}" data-has-driver="${driver ? 'true' : 'false'}">
      <option value="">— Sin asignar —</option>${typeOptions(selected)}
    </select>`;

    const tr = document.createElement('tr');
    tr.className = selected ? 'asn-row-assigned' : 'asn-row-unassigned';
    tr.setAttribute('data-vname', vehicleName.toLowerCase());
    tr.innerHTML = `
      <td><div class="asn-veh-cell"><span class="asn-vehicle-name">${vehicleName}</span>${icon}</div></td>
      <td>${typeSelect}</td>`;
    tbody.appendChild(tr);
  });

  const statsEl = document.getElementById('asnStats');
  if (statsEl) statsEl.textContent = `${assignedCount} / ${total} asignados`;

  // Sincronizar labels de botones "Asignar todos" con nombres personalizados
  const btnMap = {
    asnBtnCar:        VEHICLE_CUSTOM_NAMES.auto        || 'Auto',
    asnBtnCamioneta:  VEHICLE_CUSTOM_NAMES.camioneta   || 'Camioneta',
    asnBtnTruck:      VEHICLE_CUSTOM_NAMES.camion      || 'Camión',
    asnBtnMinibus:    VEHICLE_CUSTOM_NAMES.minibus     || 'Minibús',
    asnBtnBus:        VEHICLE_CUSTOM_NAMES.bus         || 'Bus',
    asnBtnTractomula: VEHICLE_CUSTOM_NAMES.tractomula  || 'Tractomula',
    asnBtnMoto:       VEHICLE_CUSTOM_NAMES.moto        || 'Moto'
  };
  Object.entries(btnMap).forEach(([id, label]) => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = label;
  });

  // Actualizar ícono y clase al cambiar el select
  tbody.addEventListener('change', e => {
    const sel = e.target.closest('.assign-type');
    if (!sel) return;
    const val = sel.value;
    sel.className = val ? 'asn-type-sel asn-sel-assigned assign-type' : 'asn-type-sel assign-type';
    const row = sel.closest('tr');
    row.className = val ? 'asn-row-assigned' : 'asn-row-unassigned';
    const cell = row.querySelector('.asn-veh-cell');
    const badge = cell?.querySelector('.asn-vtype-badge');
    if (badge) badge.remove();
    if (val && ASN_ICONS[val]) cell.insertAdjacentHTML('beforeend', `<span class="asn-vtype-badge">${ASN_ICONS[val]}<span class="asn-vtype-label">${ASN_LABELS[val]}</span></span>`);
    const assigned = [...tbody.querySelectorAll('.assign-type')].filter(s => s.value).length;
    if (statsEl) statsEl.textContent = `${assigned} / ${total} asignados`;
  });

  // Búsqueda
  const searchEl = document.getElementById('asnSearch');
  if (searchEl) {
    searchEl.value = '';
    searchEl.oninput = () => {
      const q = searchEl.value.toLowerCase();
      tbody.querySelectorAll('tr').forEach(r => {
        const match = !q || (r.getAttribute('data-vname') || '').includes(q);
        r.classList.toggle('asn-row-hidden', !match);
      });
    };
  }
}

function assignAllType(type) {
  const ICONS = {
    car:`<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4,16 L4,13 L9,9 L15,7 L33,7 L38,10 L43,13 L44,16 L4,16"/><line x1="15" y1="7" x2="13" y2="16"/><line x1="33" y1="7" x2="35" y2="16"/><circle cx="12" cy="19" r="3"/><circle cx="36" cy="19" r="3"/></svg>`,
    camioneta:`<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4,16 L4,11 L8,7 L14,5 L26,5 L27,8 L27,16"/><path d="M27,16 L27,10 L44,10 L44,16 L4,16"/><line x1="14" y1="5" x2="12" y2="16"/><line x1="26" y1="5" x2="26" y2="16"/><circle cx="11" cy="19" r="3"/><circle cx="37" cy="19" r="3"/></svg>`,
    truck:`<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3,17 L3,9 L6,5 L14,3 L18,3 L18,17 L3,17"/><rect x="18" y="3" width="27" height="14" rx="1"/><circle cx="9" cy="20" r="2.5"/><circle cx="27" cy="20" r="2.5"/><circle cx="38" cy="20" r="2.5"/></svg>`,
    minibus:`<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3,17 L3,8 L6,6 L42,6 L45,8 L45,17 L3,17"/><rect x="6" y="8" width="7" height="4" rx="1"/><rect x="16" y="8" width="7" height="4" rx="1"/><rect x="26" y="8" width="7" height="4" rx="1"/><rect x="36" y="8" width="6" height="4" rx="1"/><circle cx="11" cy="20" r="3"/><circle cx="37" cy="20" r="3"/></svg>`,
    bus:`<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="44" height="13" rx="2"/><rect x="6" y="6" width="7" height="5" rx="1"/><rect x="16" y="6" width="7" height="5" rx="1"/><rect x="26" y="6" width="7" height="5" rx="1"/><rect x="36" y="6" width="7" height="5" rx="1"/><circle cx="10" cy="20" r="3"/><circle cx="38" cy="20" r="3"/></svg>`,
    tractomula:`<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2,17 L2,10 L4,7 L9,4 L16,4 L18,6 L19,17"/><line x1="5" y1="11" x2="7" y2="7"/><line x1="7" y1="7" x2="14" y2="7"/><line x1="14" y1="7" x2="14" y2="11"/><rect x="20" y="6" width="26" height="11"/><circle cx="8" cy="20" r="2.5"/><circle cx="27" cy="20" r="2.5"/><circle cx="36" cy="20" r="2.5"/><circle cx="44" cy="20" r="2.5"/></svg>`,
    moto:`<svg class="asn-type-icon" viewBox="0 0 48 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="17" r="4.5"/><circle cx="40" cy="17" r="4.5"/><path d="M12,17 L17,11 L24,8 L31,11 L35,17"/><line x1="31" y1="11" x2="35" y2="13"/><line x1="8" y1="13" x2="17" y2="11"/><path d="M27,7 L33,6 L34,4"/></svg>`
  };
  const LABELS = {
    car:        VEHICLE_CUSTOM_NAMES.auto        || 'Auto',
    camioneta:  VEHICLE_CUSTOM_NAMES.camioneta   || 'Camioneta',
    truck:      VEHICLE_CUSTOM_NAMES.camion      || 'Camión',
    minibus:    VEHICLE_CUSTOM_NAMES.minibus     || 'Minibús',
    bus:        VEHICLE_CUSTOM_NAMES.bus         || 'Bus',
    tractomula: VEHICLE_CUSTOM_NAMES.tractomula  || 'Tractomula',
    moto:       VEHICLE_CUSTOM_NAMES.moto        || 'Moto'
  };
  document.querySelectorAll('#assignTable tbody tr:not(.asn-row-hidden) .assign-type').forEach(sel => {
    sel.value = type;
    sel.className = 'asn-type-sel asn-sel-assigned assign-type';
    const row = sel.closest('tr');
    row.className = 'asn-row-assigned';
    const cell = row.querySelector('.asn-veh-cell');
    cell?.querySelector('.asn-vtype-badge')?.remove();
    if (cell && ICONS[type]) cell.insertAdjacentHTML('beforeend', `<span class="asn-vtype-badge">${ICONS[type]}<span class="asn-vtype-label">${LABELS[type]}</span></span>`);
  });
  const tbody = document.querySelector('#assignTable tbody');
  const assigned = tbody ? [...tbody.querySelectorAll('.assign-type')].filter(s => s.value).length : 0;
  const statsEl = document.getElementById('asnStats');
  if (statsEl) statsEl.textContent = `${assigned} / ${DATA.vehicles.length} asignados`;
}

function openAssignModal() {
  renderAssignTable();
  new bootstrap.Modal(document.getElementById('modalAssign')).show();
}

async function saveAssign() {
  const types = {};
  const vehicleTypes = {};
  let hasAnyType = false;
  
  document.querySelectorAll('.assign-type').forEach(sel => {
    const driverId = sel.getAttribute('data-driver');
    const vehicleId = sel.getAttribute('data-vehicle');
    const hasDriver = sel.getAttribute('data-has-driver') === 'true';
    const val = sel.value;
    
    if (!val || val === '') {
      // Tipo no seleccionado, saltar
      return;
    }
    
    hasAnyType = true;
    
    if (hasDriver) {
      // Vehículo con conductor
      const drv = DATA.drivers.find(d => d.driver_id === driverId);
      if (drv) {
        drv.type = val;
        types[driverId] = val;
        
        const veh = DATA.vehicles.find(v => v.unit_id === vehicleId);
        if (veh) {
          if (val === 'truck') veh.type = 'camion';
          else if (val === 'car') veh.type = 'auto';
          else veh.type = val;
          vehicleTypes[vehicleId] = veh.type;
        }
      }
    } else {
      // Vehículo sin conductor - guardar solo el tipo del vehículo
      const veh = DATA.vehicles.find(v => v.unit_id === vehicleId);
      if (veh) {
        if (val === 'truck') veh.type = 'camion';
        else if (val === 'car') veh.type = 'auto';
        else veh.type = val;
        vehicleTypes[vehicleId] = veh.type;
      }
    }
  });
  
  // Verificar que al menos se haya asignado un tipo
  if (!hasAnyType) {
    alert(USER_LANGUAGE === 'en' ? 'Please assign at least one vehicle type before saving.' : 'Por favor asigne al menos un tipo de vehículo antes de guardar.');
    return;
  }
  
  // Ya no validamos conductores - solo guardamos los tipos asignados
  
  // Guardar tipos de conductores
  try {
    await fetch(`${API_BASE}/config/vehicle-types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: USER_TOKEN, types, vehicleTypes })
    });
    localStorage.setItem('driveiq_vehicle_types', JSON.stringify(types));
    localStorage.setItem('driveiq_vehicle_types_vehicles', JSON.stringify(vehicleTypes));
    _typesWereLoaded = true;
  } catch (e) {
    console.error('Error guardando tipos:', e);
    localStorage.setItem('driveiq_vehicle_types', JSON.stringify(types));
    localStorage.setItem('driveiq_vehicle_types_vehicles', JSON.stringify(vehicleTypes));
    _typesWereLoaded = true;
  }
  
  // Marcar como guardado si todos los conductores con vehículo tienen tipo
  const allDriversWithVehiclesHaveType = DATA.drivers.every(d => {
    const veh = DATA.vehicles.find(v => v.unit_id === d.unit_id);
    // Si tiene vehículo, debe tener tipo. Si no tiene vehículo, no importa
    return !veh || (d.type && d.type !== '');
  });
  
  typesSaved = allDriversWithVehiclesHaveType;
  
  // Cerrar modal
  const modal = bootstrap.Modal.getInstance(document.getElementById('modalAssign'));
  if (modal) {
    modal.hide();
  }
  
  // Renderizar todo
  renderAll();
  
  alert(t('save.success'));
}

function showAssignReminder() {
  const tbody = document.querySelector('#driversTable tbody');
  tbody.innerHTML = '<tr><td colspan="6"><div class="p-3 text-center text-warning">Por favor asigne los tipos de vehículo (botón "Asignar tipos de vehículo") para habilitar la vista de Conductores y rendimiento.</div></td></tr>';
  document.getElementById('totalDrivers').textContent = DATA.drivers.length;
  document.getElementById('numDrivers').textContent = DATA.drivers.length;
}

function renderAll() {
  populateFilters();
  renderDriversTable();
  renderEventsTable(DATA.events);
  renderSummary();
  renderChart(DATA.events);
}

// ── Avatar helpers ────────────────────────────────────────────────────────
const _AVT_COLORS = ['#F97316','#3B82F6','#10B981','#8B5CF6','#EC4899','#14B8A6','#F59E0B','#EF4444','#06B6D4','#84CC16'];
function driverAvatarBg(name) {
  let h = 0;
  const s = name || '?';
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return _AVT_COLORS[Math.abs(h) % _AVT_COLORS.length];
}
function driverInitials(name) {
  if (!name) return '?';
  const p = name.trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : name.slice(0,2).toUpperCase();
}

// ── Score ring SVG ────────────────────────────────────────────────────────
function scoreRing(score, size = 44) {
  if (!score && score !== 0) return '<span style="color:var(--text-secondary);font-size:0.85rem">—</span>';
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(Math.max(score, 0), 100) / 100);
  const color = score >= 80 ? '#3FB950' : score >= 60 ? '#FBBF24' : '#F85149';
  const track = score >= 80 ? 'rgba(63,185,80,0.18)' : score >= 60 ? 'rgba(251,191,36,0.18)' : 'rgba(248,81,73,0.18)';
  const fs = size < 40 ? 9 : 11;
  const half = size / 2;
  return `<div class="score-ring-wrap"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${half}" cy="${half}" r="${r}" fill="none" stroke="${track}" stroke-width="4"/>
    <circle cx="${half}" cy="${half}" r="${r}" fill="none" stroke="${color}" stroke-width="4"
      stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
      stroke-linecap="round" transform="rotate(-90 ${half} ${half})"/>
    <text x="${half}" y="${half + fs/2 + 1}" text-anchor="middle" font-size="${fs}"
      font-weight="700" fill="${color}" font-family="Inter,-apple-system,sans-serif">${score}</text>
  </svg></div>`;
}

// ── Mobile navigation ─────────────────────────────────────────────────────
function mobileNavTo(section, btn) {
  document.querySelectorAll('.mob-nav-item').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (section === 'filtros') {
    const panel = document.getElementById('sidebarPanel');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (panel && backdrop) {
      const isOpen = panel.classList.contains('mobile-open');
      panel.classList.toggle('mobile-open', !isOpen);
      backdrop.classList.toggle('active', !isOpen);
    }
    return;
  }
  const targets = { inicio: '#heroRow', conductores: '#driversSection', eventos: '#eventsSection', reportes: '#sidebarPanel' };
  const el = document.querySelector(targets[section]);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// ── Modal Reportes ────────────────────────────────────────────────────────
let _reportModal = null;
let _rptSelVehicles = new Set(); // 'ALL' = todos

function openReportsModal() {
  const el = document.getElementById('modalReports');
  if (!el) return;
  if (!_reportModal) _reportModal = new bootstrap.Modal(el);

  // Sincronizar fechas con sidebar
  const from = document.getElementById('startDate')?.value;
  const to   = document.getElementById('endDate')?.value;
  const rFrom = document.getElementById('rptFrom');
  const rTo   = document.getElementById('rptTo');
  if (rFrom && from) rFrom.value = from;
  if (rTo   && to)   rTo.value   = to;

  // Inicializar selección: todos los vehículos
  _rptSelVehicles = new Set(['ALL']);

  // Construir lista de vehículos
  _buildRptVehicleList('');
  _updateRptPreview();
  _syncRptFormats();

  // Quick ranges
  document.querySelectorAll('.rpt-range-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.rpt-range-btn').forEach(b => b.classList.remove('rpt-range-active'));
      btn.classList.add('rpt-range-active');
      const r = btn.dataset.range;
      const today = new Date();
      const from2 = new Date(today);
      let f, t2;
      if (r === 'today')      { f = t2 = today.toISOString().split('T')[0]; }
      else if (r === 'yesterday') { from2.setDate(from2.getDate()-1); f = t2 = from2.toISOString().split('T')[0]; }
      else if (r === 'last7') { from2.setDate(from2.getDate()-7); f = from2.toISOString().split('T')[0]; t2 = today.toISOString().split('T')[0]; }
      else if (r === 'last30'){ from2.setDate(from2.getDate()-30); f = from2.toISOString().split('T')[0]; t2 = today.toISOString().split('T')[0]; }
      else if (r === 'last_month') {
        const s = new Date(today.getFullYear(), today.getMonth()-1, 1);
        const e2 = new Date(today.getFullYear(), today.getMonth(), 0);
        f = s.toISOString().split('T')[0]; t2 = e2.toISOString().split('T')[0];
      }
      if (f && document.getElementById('rptFrom')) document.getElementById('rptFrom').value = f;
      if (t2 && document.getElementById('rptTo'))  document.getElementById('rptTo').value  = t2;
      _updateRptPreview();
    };
  });

  // Buscador
  const srch = document.getElementById('rptVehicleSearch');
  if (srch) srch.oninput = () => _buildRptVehicleList(srch.value.toLowerCase());

  // Formato cards
  document.querySelectorAll('.rpt-fmt-card').forEach(card => {
    card.onclick = () => card.classList.toggle('rpt-fmt-active');
  });

  // Fechas → actualizar preview
  ['rptFrom','rptTo'].forEach(id => {
    const el2 = document.getElementById(id);
    if (el2) el2.onchange = () => {
      document.querySelectorAll('.rpt-range-btn').forEach(b => b.classList.remove('rpt-range-active'));
      _updateRptPreview();
    };
  });

  _reportModal.show();
}

function _buildRptVehicleList(filter) {
  const wrap = document.getElementById('rptVehicleList');
  if (!wrap || !DATA) return;

  // "Seleccionar todos"
  const allChecked = _rptSelVehicles.has('ALL');
  let html = `<label class="rpt-veh-item rpt-veh-all">
    <input type="checkbox" class="rpt-veh-cb" data-id="ALL" ${allChecked?'checked':''}>
    <span class="rpt-veh-name">Todos los vehículos</span>
    <span class="rpt-veh-badge">${DATA.vehicles.length}</span>
  </label>`;

  if (VEHICLE_GROUPS && VEHICLE_GROUPS.length > 0) {
    // Construir mapa rápido de vehículos por unit_id
    const vehMap = {};
    (DATA.vehicles || []).forEach(v => { vehMap[String(v.unit_id)] = v; });

    VEHICLE_GROUPS.forEach(group => {
      const ids = (group.vehicle_ids || []).map(String);
      const groupVehs = ids
        .map(id => vehMap[id])
        .filter(v => v && (!filter ||
          (formatVehicleName(v)||'').toLowerCase().includes(filter) ||
          (group.name||'').toLowerCase().includes(filter)
        ));
      if (groupVehs.length === 0 && filter) return;
      if (groupVehs.length === 0 && !filter) return;
      html += `<div class="rpt-veh-group">
        <div class="rpt-veh-group-name">${group.name || 'Sin grupo'} <span class="rpt-veh-badge">${groupVehs.length}</span></div>`;
      groupVehs.forEach(v => {
        const checked = allChecked || _rptSelVehicles.has(String(v.unit_id));
        html += `<label class="rpt-veh-item">
          <input type="checkbox" class="rpt-veh-cb" data-id="${v.unit_id}" ${checked?'checked':''}>
          <span class="rpt-veh-name">${formatVehicleName(v) || v.unit_id}</span>
        </label>`;
      });
      html += '</div>';
    });

    // Vehículos sin grupo
    const assignedIds = new Set(VEHICLE_GROUPS.flatMap(g => (g.vehicle_ids||[]).map(String)));
    const ungrouped = (DATA.vehicles||[]).filter(v =>
      !assignedIds.has(String(v.unit_id)) &&
      (!filter || (formatVehicleName(v)||'').toLowerCase().includes(filter))
    );
    if (ungrouped.length > 0) {
      html += `<div class="rpt-veh-group"><div class="rpt-veh-group-name">Sin grupo <span class="rpt-veh-badge">${ungrouped.length}</span></div>`;
      ungrouped.forEach(v => {
        const checked = allChecked || _rptSelVehicles.has(String(v.unit_id));
        html += `<label class="rpt-veh-item">
          <input type="checkbox" class="rpt-veh-cb" data-id="${v.unit_id}" ${checked?'checked':''}>
          <span class="rpt-veh-name">${formatVehicleName(v) || v.unit_id}</span>
        </label>`;
      });
      html += '</div>';
    }
  } else {
    DATA.vehicles.filter(v => !filter || (v.name||'').toLowerCase().includes(filter)).forEach(v => {
      const checked = allChecked || _rptSelVehicles.has(v.unit_id?.toString());
      html += `<label class="rpt-veh-item">
        <input type="checkbox" class="rpt-veh-cb" data-id="${v.unit_id}" ${checked?'checked':''}>
        <span class="rpt-veh-name">${v.name || v.unit_id}</span>
      </label>`;
    });
  }

  wrap.innerHTML = html;

  wrap.querySelectorAll('.rpt-veh-cb').forEach(cb => {
    cb.onchange = () => {
      if (cb.dataset.id === 'ALL') {
        if (cb.checked) { _rptSelVehicles = new Set(['ALL']); wrap.querySelectorAll('.rpt-veh-cb:not([data-id="ALL"])').forEach(c => c.checked = true); }
        else { _rptSelVehicles = new Set(); wrap.querySelectorAll('.rpt-veh-cb').forEach(c => c.checked = false); }
      } else {
        _rptSelVehicles.delete('ALL');
        wrap.querySelector('.rpt-veh-cb[data-id="ALL"]').checked = false;
        if (cb.checked) _rptSelVehicles.add(cb.dataset.id);
        else _rptSelVehicles.delete(cb.dataset.id);
      }
      _updateRptPreview();
      const cntEl = document.getElementById('rptSelCount');
      if (cntEl) cntEl.textContent = _rptSelVehicles.has('ALL') ? `${DATA.vehicles.length} seleccionados` : `${_rptSelVehicles.size} seleccionados`;
    };
  });

  const cntEl = document.getElementById('rptSelCount');
  if (cntEl) cntEl.textContent = _rptSelVehicles.has('ALL') ? `${DATA.vehicles.length} seleccionados` : `${_rptSelVehicles.size} seleccionados`;
}

function _updateRptPreview() {
  if (!DATA) return;
  const selAll = _rptSelVehicles.has('ALL');
  const vehs = selAll ? DATA.vehicles : DATA.vehicles.filter(v => _rptSelVehicles.has(v.unit_id?.toString()));
  const vIds = new Set(vehs.map(v => v.unit_id));
  const drvs = DATA.drivers.filter(d => vIds.has(d.unit_id));
  const evts = DATA.events.filter(e => vIds.has(e.vehicle_id));
  const avg  = drvs.length > 0 ? Math.round(drvs.reduce((s,d) => s+(d.score||0),0)/drvs.length) : 0;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('rptPrevDrivers', drvs.length);
  set('rptPrevVehicles', vehs.length);
  set('rptPrevEvents', evts.length);
  set('rptPrevScore', drvs.length > 0 ? avg : '—');
}

function _syncRptFormats() {
  // Sincronizar con los report-btn del sidebar (legacy)
  const active = new Set([...document.querySelectorAll('.report-btn.active')].map(b => b.dataset.type));
  document.querySelectorAll('.rpt-fmt-card').forEach(card => {
    if (active.has(card.dataset.type)) card.classList.add('rpt-fmt-active');
    else card.classList.remove('rpt-fmt-active');
  });
}

function closeMobileSidebar() {
  document.getElementById('sidebarPanel')?.classList.remove('mobile-open');
  document.getElementById('sidebarBackdrop')?.classList.remove('active');
}

function renderScore(score) {
  if (!score && score !== 0) return '-';
  if (score >= 80) return `<span class="score-badge score-good">${score}</span>`;
  if (score >= 60) return `<span class="score-badge score-mid">${score}</span>`;
  return `<span class="score-badge score-bad">${score}</span>`;
}

function renderDriversTable() {
  const tbody = document.querySelector('#driversTable tbody');
  if (!tbody) return;
  
  // Aplicar filtros múltiples
  const hasVehicleFilter = selectedVehicles.size > 0;
  const hasDriverFilter = selectedDrivers.size > 0;
  
  // Si hay filtros de vehículos específicos
  if (hasVehicleFilter) {
    let itemsToShow = [];
    
    // Filtrar vehículos seleccionados
    DATA.vehicles.forEach(veh => {
      if (selectedVehicles.has(veh.unit_id)) {
        const driver = DATA.drivers.find(d => d.unit_id === veh.unit_id);
        if (driver) {
          // Si hay filtro de conductores, verificar que coincida
          if (!hasDriverFilter || selectedDrivers.has(driver.driver_id)) {
            itemsToShow.push({ type: 'driver', driver: driver, vehicle: veh });
          }
        } else {
          // Vehículo sin conductor
          itemsToShow.push({ type: 'vehicle', driver: null, vehicle: veh });
        }
      }
    });
    
    renderDriversTableContentWithVehicles(itemsToShow);
    return;
  }
  
  // Si hay filtro de conductores pero no de vehículos
  if (hasDriverFilter) {
    let itemsToShow = [];
    
    DATA.vehicles.forEach(veh => {
      const driver = DATA.drivers.find(d => d.unit_id === veh.unit_id);
      if (driver && selectedDrivers.has(driver.driver_id)) {
        itemsToShow.push({ type: 'driver', driver: driver, vehicle: veh });
      }
    });
    
    renderDriversTableContentWithVehicles(itemsToShow);
    return;
  }
  
  // Si no hay filtros (todos seleccionados o ninguno), mostrar TODOS
  let itemsToShow = [];
  
  DATA.vehicles.forEach(veh => {
    const driver = DATA.drivers.find(d => d.unit_id === veh.unit_id);
    if (driver) {
      itemsToShow.push({ type: 'driver', driver: driver, vehicle: veh });
    } else {
      // Vehículo sin conductor
      itemsToShow.push({ type: 'vehicle', driver: null, vehicle: veh });
    }
  });
  
  renderDriversTableContentWithVehicles(itemsToShow);
}

// ── Tipos de vehículo: taxonomía canónica ÚNICA (igual que el scoring del backend) ──
const VEHICLE_TYPES_CANON = ['auto', 'camioneta', 'camion', 'minibus', 'bus', 'tractomula', 'moto'];
// Normaliza valores legados (taxonomía vieja de 4) a la canónica de 7.
function normVType(t) { return ({ car: 'auto', truck: 'camion', motorcycle: 'moto' })[t] || (t || ''); }
// Etiqueta del tipo (respeta nombres personalizados de Umbrales; mismo criterio que el modal).
function vtypeLabel(k) {
  const L = VEHICLE_CUSTOM_NAMES || {};
  return ({ auto: L.auto || 'Auto', camioneta: L.camioneta || 'Camioneta', camion: L.camion || 'Camión',
            minibus: L.minibus || 'Minibús', bus: L.bus || 'Bus', tractomula: L.tractomula || 'Tractomula',
            moto: L.moto || 'Moto' })[k] || k;
}
// HTML de un <select> de tipo con las 7 opciones canónicas; marca el actual (normalizado).
function vtypeSelectHTML(attrName, attrVal, current, extraAttrs) {
  const cur = normVType(current);
  const opts = VEHICLE_TYPES_CANON.map(k => `<option value="${k}"${cur === k ? ' selected' : ''}>${vtypeLabel(k)}</option>`).join('');
  return `<select class="form-select form-select-sm type-select" ${attrName}="${attrVal}"${extraAttrs || ''}>${opts}</select>`;
}

function renderDriversTableContent(driversToShow) {
  const tbody = document.querySelector('#driversTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  // Aplicar filtro por score
  let filtered = driversToShow.filter(d => {
    const score = d.score || 0;
    return score <= RANKING_MAX_SCORE;
  });
  
  // Aplicar ordenamiento
  const driversSorted = filtered.slice().sort((a, b) => {
    const scoreA = a.score || 0;
    const scoreB = b.score || 0;
    if (RANKING_ORDER === 'asc') {
      return scoreA - scoreB; // Peor a mejor
    } else {
      return scoreB - scoreA; // Mejor a peor
    }
  });
  
  driversSorted.forEach(d => {
    const veh = DATA.vehicles.find(v => v.unit_id === d.unit_id);
    const vehicleName = veh ? formatVehicleName(veh) : (d.unit_id ? `Vehículo ${d.unit_id}` : '-');
    const typeSelect = vtypeSelectHTML('data-driver', d.driver_id, d.type);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><a href="#" class="driver-link" data-id="${d.driver_id}">${d.name}</a></td><td>${vehicleName} <span class="vehicle-source" title="source"></span></td><td>${typeSelect}</td><td>${d.events_count || 0}</td><td>${renderScore(d.score)}</td>`;
tbody.appendChild(tr);
});
  
  // Re-agregar event listeners
  addTableEventListeners();
  document.getElementById('totalDrivers').textContent = driversSorted.length;
  updateVehicleSourceIcons();
}

function renderDriversTableContentWithVehicles(itemsToShow) {
  const tbody = document.querySelector('#driversTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // Separar: con tipo asignado vs pendientes de asignación
  function hasType(item) {
    const type = item.driver ? item.driver.type : item.vehicle.type;
    return type && type !== '';
  }

  const assigned = itemsToShow.filter(item => hasType(item));
  const pending  = itemsToShow.filter(item => !hasType(item));

  // Filtro por score solo aplica a los asignados
  let filtered = assigned.filter(item => {
    const score = item.driver ? (item.driver.score || 0)
      : calculateVehicleScore(item.vehicle, DATA.events.filter(e => e.vehicle_id === item.vehicle.unit_id));
    return score <= RANKING_MAX_SCORE;
  });

  // Ordenar asignados
  filtered.sort((a, b) => {
    const sA = a.driver ? (a.driver.score || 0)
      : calculateVehicleScore(a.vehicle, DATA.events.filter(e => e.vehicle_id === a.vehicle.unit_id));
    const sB = b.driver ? (b.driver.score || 0)
      : calculateVehicleScore(b.vehicle, DATA.events.filter(e => e.vehicle_id === b.vehicle.unit_id));
    return RANKING_ORDER === 'asc' ? sA - sB : sB - sA;
  });

  // Paginación — incluye tanto asignados como pendientes
  const totalFiltered = filtered.length;
  const totalAll = filtered.length + pending.length;
  const totalPages = Math.max(1, Math.ceil(totalAll / PAGE_SIZE));
  driversPage = Math.min(driversPage, totalPages);
  const pageStart = (driversPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // Renderizar asignados (solo la página actual)
  pageItems.forEach(item => {
    const d = item.driver;
    const veh = item.vehicle;
    const vehicleName = formatVehicleName(veh);
    let driverLink, typeSelect, eventsCount, score;

    const hasRealDriver = d && d.has_driver === true;
    if (d) {
      driverLink = hasRealDriver
        ? `<a href="#" class="driver-link" data-id="${d.driver_id}">${d.name}</a><div class="drv-no-driver" style="opacity:.55;font-size:.72rem">${d.vehicle_name || vehicleName}</div>`
        : `<span class="drv-vehicle-name">${vehicleName}</span>`;
      typeSelect = vtypeSelectHTML('data-driver', d.driver_id, d.type);
      eventsCount = d.events_count || 0;
      score = renderScore(d.score);
    } else {
      driverLink = `<span class="drv-vehicle-name">${vehicleName}</span>`;
      typeSelect = vtypeSelectHTML('data-vehicle', veh.unit_id, veh.type, ' data-has-driver="false"');
      const vEvents = DATA.events.filter(e => e.vehicle_id === veh.unit_id);
      eventsCount = vEvents.length;
      score = renderScore(calculateVehicleScore(veh, vEvents));
    }

    const _noDriverTxt = !hasRealDriver
      ? `<div class="drv-no-driver">Sin conductor · <a href="https://pilotos.gpssoftwarenumberone.com" target="_blank" style="color:#b45309;font-weight:600;text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">Asígnelo en PilotOS</a></div>`
      : `<div class="drv-sub d-lg-none">${vehicleName}</div>`;
    const _conductorCell = `<div class="drv-info">${driverLink}${_noDriverTxt}</div>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${_conductorCell}</td>
      <td class="d-none d-lg-table-cell">${vehicleName} <span class="vehicle-source" title="source"></span></td>
      <td>${typeSelect}</td>
      <td>${eventsCount}</td>
      <td>${score}</td>`;
    tbody.appendChild(tr);
  });

  // Separador y pendientes al final (paginados también)
  if (pending.length > 0) {
    const pendingPages = Math.ceil(pending.length / PAGE_SIZE);
    // pendingPage compartida con driversPage (simplificación: mismo control de página)
    const pStart = (driversPage - 1) * PAGE_SIZE;
    const pendingSlice = pending.slice(pStart, pStart + PAGE_SIZE);

    const sep = document.createElement('tr');
    sep.innerHTML = `<td colspan="5" style="background:rgba(251,191,36,0.08);border-top:2px solid #f59e0b;padding:10px 16px;text-align:center;">
      <span style="color:var(--text-primary);font-weight:600;font-size:0.9rem;">
        <span style="color:#f59e0b;">⚠</span> ${pending.length} vehículo${pending.length>1?'s':''} pendiente${pending.length>1?'s':''} de asignación
      </span>
      &nbsp;<button class="btn btn-sm btn-warning" style="font-size:0.8rem;padding:3px 10px;" onclick="openAssignModal()">Asignar tipo</button>
    </td>`;
    tbody.appendChild(sep);

    pendingSlice.forEach(item => {
      const veh = item.vehicle;
      const d = item.driver;
      const vehicleName = formatVehicleName(veh);
      const hasRealD = d && d.has_driver === true;
      const nameText = hasRealD ? d.name : (vehicleName || `Vehículo ${veh.unit_id}`);
      const nameEl = hasRealD
        ? `<a href="#" class="driver-link" data-id="${d.driver_id}" style="opacity:.6">${nameText}</a>`
        : `<span style="opacity:.6">${nameText}</span>`;
      const noDriverTxt = !hasRealD
        ? `<div class="drv-no-driver">Sin conductor · <a href="https://pilotos.gpssoftwarenumberone.com" target="_blank" style="color:#b45309;font-weight:600;text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">Asígnelo en PilotOS</a></div>`
        : '';
      const conductorCell = `<div class="drv-info">${nameEl}${noDriverTxt}</div>`;
      const tr = document.createElement('tr');
      tr.style.opacity = '0.55';
      tr.innerHTML = `<td>${conductorCell}</td><td>${vehicleName} <span class="vehicle-source" title="source"></span></td>
        <td><span style="color:#f59e0b;font-size:0.8rem;font-weight:600;">⏳ Pendiente</span></td>
        <td>—</td>
        <td><span style="color:#94a3b8;font-size:0.8rem;">Sin medición</span></td>`;
      tbody.appendChild(tr);
    });
  }

  // Debug strip — siempre visible para diagnóstico
  // Paginador de conductores (el div ya existe en el HTML)
  const pagEl = document.getElementById('driversPaginator');
  if (pagEl) pagEl.innerHTML = totalPages > 1 ? renderPaginator(driversPage, totalPages, totalAll, 'drivers') : '';

  addTableEventListeners();
  document.getElementById('totalDrivers').textContent = totalFiltered;
  updateVehicleSourceIcons();
}

function addTableEventListeners() {
  document.querySelectorAll('.type-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const id = e.target.getAttribute('data-driver');
      const val = e.target.value;
      const drv = DATA.drivers.find(x => x.driver_id === id);
      if (drv) {
        drv.type = val;
        // Actualizar también el tipo del vehículo asociado
        const veh = DATA.vehicles.find(v => v.unit_id === drv.unit_id);
        if (veh) {
          if (val === 'truck') veh.type = 'camion';
          else if (val === 'car') veh.type = 'auto';
          else veh.type = val;
        }
      }
      typesSaved = false;
      const types = {};
      DATA.drivers.forEach(d => {
        if (d.type) types[d.driver_id] = d.type;
      });
      try {
        await fetch(`${API_BASE}/config/vehicle-types`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: USER_TOKEN, types })
        });
        localStorage.setItem('driveiq_vehicle_types', JSON.stringify(types));
      } catch (e) {
        localStorage.setItem('driveiq_vehicle_types', JSON.stringify(types));
      }
    });
  });
  
  document.querySelectorAll('.driver-link').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      openDriverDetailById(a.getAttribute('data-id'));
    });
  });
}

function updateVehicleSourceIcons() {
  document.querySelectorAll('#driversTable tbody tr').forEach((tr) => {
    const linkEl = tr.querySelector('.driver-link');
    const span = tr.querySelector('.vehicle-source');
    if (!linkEl || !span) return; // filas separadoras o pendientes sin driver-link
    const name = linkEl.textContent;
    const drv = DATA.drivers.find(d => d.name === name);
    const veh = DATA.vehicles.find(v => v.unit_id === (drv && drv.unit_id));
    // Fuente real según los eventos del vehículo (no por tener cualquier sensor:
    // el odómetro NO es acelerómetro). ⚙️ si reporta por acelerómetro; si no, 🛰 GPS.
    const vid = (veh && veh.unit_id) || (drv && drv.unit_id);
    const evs = vid ? DATA.events.filter(e => e.vehicle_id === vid || e.driver_id === vid) : [];
    if (evs.some(e => e.source === 'accelerometer')) {
      span.textContent = '⚙️';
      span.title = 'Fuente: Sensor (acelerómetro)';
    } else {
      span.textContent = '🛰️';
      span.title = 'Fuente: GPS';
    }
  });
}

// ── Paginador genérico ────────────────────────────────────────────────────
function renderPaginator(page, total, totalItems, key) {
  const prevDis = page <= 1 ? 'disabled' : '';
  const nextDis = page >= total ? 'disabled' : '';
  let pages = '';
  const delta = 2;
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= page - delta && i <= page + delta)) {
      pages += `<button class="pag-btn${i === page ? ' pag-active' : ''}" onclick="goPage('${key}',${i})">${i}</button>`;
    } else if (i === page - delta - 1 || i === page + delta + 1) {
      pages += `<span class="pag-ellipsis">…</span>`;
    }
  }
  return `<div class="pag-wrap">
    <button class="pag-btn pag-arrow ${prevDis}" onclick="goPage('${key}',${page-1})" ${prevDis}>‹</button>
    ${pages}
    <button class="pag-btn pag-arrow ${nextDis}" onclick="goPage('${key}',${page+1})" ${nextDis}>›</button>
    <span class="pag-info">${totalItems} registros</span>
  </div>`;
}
function goPage(key, page) {
  if (key === 'drivers') { driversPage = page; renderDriversTable(); }
  if (key === 'events')  { eventsPage  = page; renderEventsTable(DATA.events); }
}

// Etiqueta traducida del tipo de evento (un solo lugar para TODA la app).
// Evita mostrar códigos técnicos en inglés (overspeed/custom/hard_turn).
function eventTypeLabel(type) {
  switch (type) {
    case 'overspeed': return t('overspeed');
    case 'acceleration': case 'hard_acceleration': return t('accelerations');
    case 'braking': case 'hard_brake': case 'hard_braking': return t('braking');
    case 'hard_turn': case 'corner': case 'hard_cornering': return t('hard_turns');
    default: return type || '';
  }
}

function renderEventsTable(events) {
  const tbody = document.querySelector('#eventsTable tbody');
  tbody.innerHTML = '';
  const totalEv = events.length;
  const totalPages = Math.max(1, Math.ceil(totalEv / PAGE_SIZE));
  eventsPage = Math.min(eventsPage, totalPages);
  const pageStart = (eventsPage - 1) * PAGE_SIZE;
  const pageEvents = events.slice(pageStart, pageStart + PAGE_SIZE);
  pageEvents.forEach(e => {
    const d = DATA.drivers.find(x => x.driver_id === e.driver_id);
    const map = `https://www.google.com/maps?q=${e.lat},${e.lon}`;
    // Etiqueta traducida (nunca el código técnico en inglés)
    const eventType = eventTypeLabel(e.type);
    // Icono de fuente de medición, junto al nombre del carro:
    //   ⚙️ acelerómetro (aceleración/frenada/giro)  ·  🛰 GPS/distancia (exceso de velocidad)
    const srcBadge = e.source === 'accelerometer'
      ? `<span class="ev-source-badge" title="Medido por acelerómetro">⚙️</span>`
      : e.source === 'gps'
      ? `<span class="ev-source-badge" title="Medido por GPS (distancia)">🛰</span>`
      : '';
    // Vehículo: nombre real del evento (device_name) con fallback al catálogo.
    const veh = DATA.vehicles && DATA.vehicles.find(v => v.vehicle_id === e.vehicle_id);
    const vehName = e.vehicle_name || (veh ? veh.name : '') || '';
    // Conductor: el asignado en PilotOS (viene en el evento); fallback al lookup.
    const drvName = e.driver || (d ? d.name : '') || '';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${e.trip_id || ''}</td><td>${vehName}${srcBadge ? ' ' + srcBadge : ''}</td><td>${drvName}</td><td>${eventType}</td><td>${e.severity}</td><td>${formatDateTime(e.ts)}</td><td>${safeFormatSpeed(e.speed)}</td><td><a class="map-link" target="_blank" href="${map}">${t('view_on_map')}</a></td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('numEvents').textContent = totalEv;

  // Paginador de eventos (el div ya existe en el HTML)
  const evPag = document.getElementById('eventsPaginator');
  if (evPag) evPag.innerHTML = totalPages > 1 ? renderPaginator(eventsPage, totalPages, totalEv, 'events') : '';
}

function renderSummary() {
  const dCount = DATA.drivers.length;
  const avg = dCount > 0 ? Math.round(DATA.drivers.reduce((s, d) => s + (d.score || 0), 0) / dCount) : 0;
  const eCount = DATA.events.length;
  const vCount = DATA.vehicles.length;

  // Legacy sidebar elements
  const avgEl = document.getElementById('avgScoreSmall');
  if (avgEl) avgEl.textContent = dCount > 0 ? avg : '—';
  const ndEl = document.getElementById('numDrivers');
  if (ndEl) ndEl.textContent = dCount;
  const neEl = document.getElementById('numEvents');
  if (neEl) neEl.textContent = eCount;

  // ── Hero KPI cards ────────────────────────────────────────────────────
  const scoreColor = avg >= 80 ? '#3FB950' : avg >= 60 ? '#FBBF24' : '#F85149';
  const scoreLabel = avg >= 80 ? 'Excelente' : avg >= 60 ? 'Regular' : 'Crítico';

  const ksvEl = document.getElementById('kpiScoreVal');
  if (ksvEl) {
    ksvEl.textContent = dCount > 0 ? avg : '—';
    ksvEl.style.color = dCount > 0 ? scoreColor : '';
  }
  const ksbEl = document.getElementById('kpiScoreBadge');
  if (ksbEl && dCount > 0) {
    ksbEl.textContent = t(scoreLabel);
    ksbEl.style.background = scoreColor + '22';
    ksbEl.style.color = scoreColor;
  }
  const ksbBarEl = document.getElementById('kpiScoreBar');
  if (ksbBarEl) ksbBarEl.style.width = (dCount > 0 ? avg : 0) + '%';

  const assignedDrivers = DATA.drivers.filter(d => d.has_driver === true).length;
  const kdvEl = document.getElementById('kpiDriversVal');
  if (kdvEl) kdvEl.textContent = assignedDrivers || '—';
  const kdbEl = document.getElementById('kpiDriversBadge');
  if (kdbEl) { kdbEl.textContent = vCount > 0 ? `${assignedDrivers}/${vCount}` : ''; }
  const kdbBarEl = document.getElementById('kpiDriversBar');
  if (kdbBarEl) kdbBarEl.style.width = vCount > 0 ? Math.min((assignedDrivers / vCount) * 100, 100) + '%' : '0%';

  // Breakdown de eventos por severidad
  let high = 0, mid = 0;
  DATA.events.forEach(e => {
    if (e.severity === 'alto') high++;
    else if (e.severity === 'medio') mid++;
  });
  const kevEl = document.getElementById('kpiEventsVal');
  if (kevEl) kevEl.textContent = eCount || '—';
  const kebEl = document.getElementById('kpiEventsBadge');
  if (kebEl && high > 0) {
    kebEl.textContent = t(high > 1 ? '{n} altos' : '{n} alto').replace('{n}', high);
    kebEl.style.background = 'rgba(248,81,73,0.15)';
    kebEl.style.color = '#F85149';
  }
  const kebBarEl = document.getElementById('kpiEventsBar');
  if (kebBarEl) kebBarEl.style.width = dCount > 0 ? Math.min((eCount / Math.max(dCount * 8, 1)) * 100, 100) + '%' : '0%';

  const kvvEl = document.getElementById('kpiVehiclesVal');
  if (kvvEl) kvvEl.textContent = vCount || '—';
  const kvbEl = document.getElementById('kpiVehiclesBadge');
  // Vehículos con actividad en el período (al menos 1 evento)
  const vehicleIdsWithEvents = new Set(DATA.events.map(e => e.vehicle_id));
  const activeVehicles = DATA.vehicles.filter(v => vehicleIdsWithEvents.has(v.unit_id)).length;
  const vActivePct = vCount > 0 ? Math.round((activeVehicles / vCount) * 100) : 0;
  if (kvbEl) { kvbEl.textContent = vCount > 0 ? t('Activos') : ''; kvbEl.style.background = 'rgba(63,185,80,0.15)'; kvbEl.style.color = '#3FB950'; }
  const kvbBarEl = document.getElementById('kpiVehiclesBar');
  if (kvbBarEl) kvbBarEl.style.width = vActivePct + '%';

  // Tooltip en cada tarjeta para explicar la barra
  const scoreBarTrack = document.querySelector('#kpiScoreBar')?.closest('.kpi-bar-track');
  if (scoreBarTrack) scoreBarTrack.title = t('Puntaje promedio: {n}/100').replace('{n}', avg);
  const driversBarTrack = document.querySelector('#kpiDriversBar')?.closest('.kpi-bar-track');
  if (driversBarTrack) driversBarTrack.title = t('{d} conductores de {v} vehículos ({p}%)').replace('{d}', dCount).replace('{v}', vCount).replace('{p}', vCount > 0 ? Math.round((dCount/vCount)*100) : 0);
  const eventsBarTrack = document.querySelector('#kpiEventsBar')?.closest('.kpi-bar-track');
  if (eventsBarTrack) {
    const evPct = dCount > 0 ? Math.min(Math.round((eCount / Math.max(dCount * 8, 1)) * 100), 100) : 0;
    eventsBarTrack.title = t('{n} eventos — {p}% del umbral de alerta').replace('{n}', eCount).replace('{p}', evPct);
  }
  const vehiclesBarTrack = document.querySelector('#kpiVehiclesBar')?.closest('.kpi-bar-track');
  if (vehiclesBarTrack) vehiclesBarTrack.title = t('{a} de {v} vehículos con actividad en el período ({p}%)').replace('{a}', activeVehicles).replace('{v}', vCount).replace('{p}', vActivePct);
}

const EV_DISPLAY = {
  hard_braking:      { label: 'Frenadas bruscas',      grad: 'linear-gradient(90deg,#F85149,#FC8181)', dot: '#F85149' },
  braking:           { label: 'Frenadas bruscas',      grad: 'linear-gradient(90deg,#F85149,#FC8181)', dot: '#F85149' },
  hard_brake:        { label: 'Frenadas bruscas',      grad: 'linear-gradient(90deg,#F85149,#FC8181)', dot: '#F85149' },
  hard_acceleration: { label: 'Aceleraciones bruscas', grad: 'linear-gradient(90deg,#F97316,#FDBA74)', dot: '#F97316' },
  acceleration:      { label: 'Aceleraciones bruscas', grad: 'linear-gradient(90deg,#F97316,#FDBA74)', dot: '#F97316' },
  hard_cornering:    { label: 'Giros bruscos',         grad: 'linear-gradient(90deg,#3B82F6,#93C5FD)', dot: '#3B82F6' },
  hard_turn:         { label: 'Giros bruscos',         grad: 'linear-gradient(90deg,#3B82F6,#93C5FD)', dot: '#3B82F6' },
  corner:            { label: 'Giros bruscos',         grad: 'linear-gradient(90deg,#3B82F6,#93C5FD)', dot: '#3B82F6' },
  overspeed:         { label: 'Exceso de velocidad',   grad: 'linear-gradient(90deg,#FBBF24,#FDE68A)', dot: '#FBBF24' },
};

function renderChart(events) {
  const wrap = document.getElementById('eventChart');
  if (!wrap) return;

  // Agrupar por tipo normalizado
  const grouped = {};
  events.forEach(e => {
    const key = e.type || 'otro';
    grouped[key] = (grouped[key] || 0) + 1;
  });

  const total = events.length;
  const totEl = document.getElementById('evChartTotal');
  if (totEl) totEl.textContent = total > 0 ? `${total} eventos` : '';

  if (total === 0) {
    wrap.innerHTML = '<div class="ev-chart-empty">Sin eventos en el período seleccionado</div>';
    return;
  }

  // Consolidar tipos similares (braking → hard_braking, etc.)
  const consolidated = {};
  Object.entries(grouped).forEach(([type, count]) => {
    const def = EV_DISPLAY[type];
    const label = def ? def.label : eventTypeLabel(type);
    consolidated[label] = (consolidated[label] || { count: 0, def: def || { grad: 'linear-gradient(90deg,#64748B,#94A3B8)', dot: '#64748B' } });
    consolidated[label].count += count;
  });

  // Ordenar de mayor a menor
  const sorted = Object.entries(consolidated).sort((a, b) => b[1].count - a[1].count);
  const max = sorted[0]?.[1].count || 1;

  wrap.innerHTML = sorted.map(([label, { count, def }], i) => {
    const pct = Math.round((count / total) * 100);
    const barW = Math.round((count / max) * 100);
    return `
      <div class="ev-row" style="animation-delay:${i * 0.06}s">
        <div class="ev-row-meta">
          <span class="ev-dot" style="background:${def.dot}"></span>
          <span class="ev-row-label">${label}</span>
          <span class="ev-row-pct">${pct}%</span>
        </div>
        <div class="ev-bar-track">
          <div class="ev-bar-fill" style="background:${def.grad};width:0%" data-w="${barW}"></div>
        </div>
        <span class="ev-row-count">${count}</span>
      </div>`;
  }).join('');

  // Animar barras después del render
  requestAnimationFrame(() => {
    wrap.querySelectorAll('.ev-bar-fill').forEach(bar => {
      bar.style.width = bar.dataset.w + '%';
    });
  });
}

async function openDriverDetailById(id) {
  currentDriverId = id;
  const d = DATA.drivers.find(x => x.driver_id === id);
  if (!d) return;
  const veh = DATA.vehicles.find(v => v.unit_id === d.unit_id);
  document.getElementById('detailDriverName').textContent = d.name;
  document.getElementById('detailVehicleName').textContent = formatVehicleName(veh);
  const tbody = document.querySelector('#detailEventsTable tbody');
  tbody.innerHTML = '';
  const events = DATA.events.filter(e => e.driver_id === id);
  // Icono de fuente real del vehículo según sus eventos (no por tener odómetro).
  const icon = document.getElementById('vehicleSourceIcon');
  icon.innerHTML = '';
  if (events.some(e => e.source === 'accelerometer')) {
    icon.textContent = '⚙️';
    icon.title = 'Fuente: Sensor (acelerómetro)';
  } else {
    icon.textContent = '🛰️';
    icon.title = 'Fuente: GPS';
  }
  events.forEach(e => {
    const tr = document.createElement('tr');
    const map = `https://www.google.com/maps?q=${e.lat},${e.lon}`;
    tr.innerHTML = `<td>${e.trip_id || ''}</td><td>${eventTypeLabel(e.type)}</td><td>${e.severity}</td><td>${new Date(e.ts).toLocaleString()}</td><td><a class="map-link" target="_blank" href="${map}">Ver en mapa</a></td>`;
    tbody.appendChild(tr);
  });
  if (veh && veh.unit_id && USER_TOKEN) {
    try {
      const servicesData = await loadServices(USER_TOKEN, veh.unit_id);
      renderServices(servicesData.services, servicesData.has_expired);
    } catch (e) {
      console.error('Error cargando servicios:', e);
      renderServices([], false);
    }
  } else {
    renderServices([], false);
  }
  offcanvas.show();
}

function renderServices(services, hasExpired) {
  const container = document.getElementById('servicesContainer');
  if (!container) return;
  if (services.length === 0) {
    container.innerHTML = '<div class="alert alert-info">No hay servicios registrados para este vehículo.</div>';
    return;
  }
  let html = '<h6 class="mt-3 mb-2">Servicios (Mantenimientos)</h6><div class="table-responsive"><table class="table table-sm table-bordered"><thead><tr><th>Servicio</th><th>Fecha Vencimiento</th><th>Estado</th></tr></thead><tbody>';
  services.forEach(service => {
    const expired = service.expired === 1;
    const statusClass = expired ? 'danger' : 'success';
    const statusText = expired ? 'Vencido' : 'Vigente';
    const statusIcon = expired ? '❌' : '✅';
    html += `<tr class="${expired ? 'table-danger' : ''}"><td>${service.name || 'N/A'}</td><td>${service.expires_date || 'N/A'}</td><td><span class="badge bg-${statusClass}">${statusIcon} ${statusText}</span></td></tr>`;
  });
html += '</tbody></table></div>';
  if (hasExpired) {
    html += '<div class="alert alert-danger mt-2"><strong>⚠️ Atención:</strong> Este vehículo tiene servicios vencidos.</div>';
  }
  container.innerHTML = html;
}

function downloadDriverJson(id) {
  const d = DATA.drivers.find(x => x.driver_id === id);
  const ev = DATA.events.filter(e => e.driver_id === id);
  downloadBlob(new Blob([JSON.stringify({ driver: d, events: ev }, null, 2)], { type: 'application/json' }), `driver_${d.name.replace(/\s+/g, '_')}.json`);
}

function downloadDriverCsv(id) {
  const d = DATA.drivers.find(x => x.driver_id === id);
  const ev = DATA.events.filter(e => e.driver_id === id);
  // CSV: incluir unidades en header
  const speedUnit = (typeof USER_UNITS !== 'undefined' && USER_UNITS === 'imperial') ? 'mph' : 'km/h';
  let csv = `trip,driver,type,severity,ts,lat,lon,speed_${speedUnit}\n`;
  ev.forEach(e => {
    const formattedSpeed = safeFormatSpeed(e.speed);
    const speedValue = formattedSpeed.replace(/\s*(km\/h|mph)/, ''); // Extraer solo el número
    csv += `${e.trip_id},${d.name},${e.type},${e.severity},${e.ts},${e.lat},${e.lon},${speedValue}\n`;
  });
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `driver_${d.name.replace(/\s+/g, '_')}.csv`);
}

function downloadDriverXls(id) {
  const d = DATA.drivers.find(x => x.driver_id === id);
  const ev = DATA.events.filter(e => e.driver_id === id);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(ev);
  XLSX.utils.book_append_sheet(wb, ws, 'events');
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(new Blob([wbout], { type: 'application/octet-stream' }), `driver_${d.name.replace(/\s+/g, '_')}.xlsx`);
}

function downloadDriverPdf(id) {
  const d = DATA.drivers.find(x => x.driver_id === id);
  const el = document.querySelector('.offcanvas-body');
  html2pdf().from(el).set({ margin: 0.5, filename: `driver_${d.name.replace(/\s+/g, '_')}.pdf` }).save();
}

function downloadDriverHtml(id) {
  const d = DATA.drivers.find(x => x.driver_id === id);
  const ev = DATA.events.filter(e => e.driver_id === id);
  const veh = DATA.vehicles.find(v => v.unit_id === d.unit_id);
  let html = `<!DOCTYPE html><html lang="${USER_LANGUAGE}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${d.name} - DriveIQ</title><style>body{font-family:Arial,sans-serif;margin:20px;background:#0B1220;color:#E6EDF3}h1{color:#E6EDF3}table{border-collapse:collapse;width:100%;background:#0F1A2E;margin:20px 0;border:1px solid #1C2A44}th,td{border:1px solid #1C2A44;padding:12px;text-align:left;color:#E6EDF3}th{background:#121F36;color:#E6EDF3;font-weight:600}tr:nth-child(even){background:#121F36}a{color:#2F81F7;text-decoration:none}a:hover{text-decoration:underline}.score{font-weight:700;padding:6px 10px;border-radius:6px;display:inline-block}.score-good{background:#3FB950;color:#fff}.score-mid{background:#D29922;color:#fff}.score-bad{background:#F85149;color:#fff}small{color:#8B949E}</style></head><body><h1>${d.name}</h1><p><strong>${USER_LANGUAGE === 'en' ? 'Vehicle' : 'Vehículo'}:</strong> ${formatVehicleName(veh) || 'N/A'}</p><p><strong>${USER_LANGUAGE === 'en' ? 'Score' : 'Puntuación'}:</strong> <span class="score ${d.score >= 80 ? 'score-good' : d.score >= 60 ? 'score-mid' : 'score-bad'}">${d.score || 0}</span></p><h2>${USER_LANGUAGE === 'en' ? 'Events' : 'Eventos'}</h2><table><thead><tr><th>${USER_LANGUAGE === 'en' ? 'Trip ID' : 'ID Viaje'}</th><th>${USER_LANGUAGE === 'en' ? 'Type' : 'Tipo'}</th><th>${USER_LANGUAGE === 'en' ? 'Severity' : 'Severidad'}</th><th>${USER_LANGUAGE === 'en' ? 'Date' : 'Fecha'}</th><th>${USER_LANGUAGE === 'en' ? 'Speed' : 'Velocidad'}</th><th>${USER_LANGUAGE === 'en' ? 'Location' : 'Ubicación'}</th></tr></thead><tbody>`;
  ev.forEach(e => {
    const map = `https://www.google.com/maps?q=${e.lat},${e.lon}`;
    const eventTypeReport = eventTypeLabel(e.type);

    html += `<tr><td>${e.trip_id || ''}</td><td>${eventTypeReport}</td><td>${e.severity}</td><td>${formatDateTime(e.ts)}</td><td>${safeFormatSpeed(e.speed)}</td><td><a href="${map}" target="_blank">${t('view_on_map')}</a></td></tr>`;
  });
  html += `</tbody></table><p><small>${t('report.generated_by')} DriveIQ - ${formatDateTime(new Date().toISOString())}</small></p></body></html>`;
  downloadBlob(new Blob([html], { type: 'text/html' }), `driver_${d.name.replace(/\s+/g, '_')}.html`);
}

function toggleReportButton(btn) {
  btn.classList.toggle('active');
}

// ── Perfiles sectoriales ─────────────────────────────────────────────────────

function openProfiles() {
  const body = document.getElementById('profilesBody');
  if (!body) return;

  const defaultNames = {
    auto:'Automóvil', camioneta:'Camioneta / Pickup', camion:'Camión mediano',
    minibus:'Minibús / Van', bus:'Bus / Autobús', tractomula:'Tractomula / Semi', moto:'Motocicleta'
  };

  let html = `<p class="profile-intro">Los perfiles sectoriales ajustan automáticamente los umbrales de los tipos de vehículo relevantes según las exigencias específicas de cada sector de operación. Son un punto de partida diseñado para entornos de alta responsabilidad.</p>`;

  Object.entries(SECTOR_PROFILES).forEach(([key, p]) => {
    const rows = p.applies.map(vtype => {
      const t = p.thresholds[vtype];
      const cur = WORKING_THRESHOLDS[vtype] || RECOMMENDED[vtype] || {};
      return `<tr>
        <td class="profile-vname">${defaultNames[vtype] || vtype}</td>
        <td class="profile-val">${t.accel}g</td>
        <td class="profile-val">${t.braking}g</td>
        <td class="profile-val">${t.corner}°</td>
        <td class="profile-cur">${cur.accel ?? '—'}g / ${cur.braking ?? '—'}g / ${cur.corner ?? '—'}°</td>
      </tr>`;
    }).join('');

    html += `
    <div class="profile-card" id="profile-card-${key}">
      <div class="profile-card-header">
        <div class="profile-card-title">${p.label}</div>
        <div class="profile-card-sub">${p.sublabel}</div>
      </div>
      <p class="profile-card-detail">${p.detail}</p>
      <div class="profile-table-wrap">
        <table class="profile-table">
          <thead><tr>
            <th>Tipo de vehículo</th>
            <th>Aceleración</th>
            <th>Frenada</th>
            <th>Giro</th>
            <th>Valor actual</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="profile-card-footer">
        <button class="btn btn-primary btn-sm" onclick="applyProfile('${key}')">Aplicar perfil</button>
        <span class="profile-affects">Afecta: ${p.applies.map(v => defaultNames[v] || v).join(', ')}</span>
      </div>
    </div>`;
  });

  body.innerHTML = html;
  bootstrap.Modal.getInstance(document.getElementById('modalThresholds'))?.hide();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProfiles')).show();
}

function applyProfile(key) {
  const profile = SECTOR_PROFILES[key];
  if (!profile) return;
  Object.entries(profile.thresholds).forEach(([vtype, vals]) => {
    if (!WORKING_THRESHOLDS[vtype]) WORKING_THRESHOLDS[vtype] = {};
    Object.assign(WORKING_THRESHOLDS[vtype], vals);
  });
  localStorage.setItem('driveiq_thresholds', JSON.stringify(WORKING_THRESHOLDS));
  bootstrap.Modal.getInstance(document.getElementById('modalProfiles'))?.hide();
  setTimeout(() => {
    openThresholds();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalThresholds')).show();
  }, 350);
}

// ── Calibración adaptativa de umbrales ───────────────────────────────────────

function runFleetCalibration() {
  const drivers = (DATA && DATA.drivers) ? [...DATA.drivers] : [];
  const events  = (DATA && DATA.events)  ? [...DATA.events]  : [];

  // Validaciones mínimas
  const withScore = drivers.filter(d => d.score != null && d.score > 0);
  if (withScore.length < 3) {
    showCalibrationError('Se necesitan al menos 3 conductores con datos registrados para calibrar.');
    return;
  }
  if (events.length < 20) {
    showCalibrationError('No hay suficientes eventos en el período seleccionado para hacer el análisis.');
    return;
  }

  // Top 20% conductores por puntuación
  const sorted   = [...withScore].sort((a, b) => b.score - a.score);
  const topCount = Math.max(1, Math.ceil(sorted.length * 0.20));
  const topDrivers = sorted.slice(0, topCount);
  const topIds   = new Set(topDrivers.map(d => d.id || d.driver_id || d.unit_id));

  // Leer tipos asignados
  const savedTypes   = JSON.parse(localStorage.getItem('driveiq_vehicle_types') || '{}');
  const savedVehicle = JSON.parse(localStorage.getItem('driveiq_vehicle_types_vehicles') || '{}');

  function resolveType(e) {
    let t = savedTypes[e.driver_id] || savedVehicle[e.vehicle_id] || 'auto';
    if (t === 'car')   t = 'auto';
    if (t === 'truck') t = 'camion';
    return t;
  }

  // Agrupar valores reales de eventos por tipo de vehículo
  const buckets = {};
  events.forEach(e => {
    if (!topIds.has(e.driver_id) && !topIds.has(e.vehicle_id)) return;
    const val = Math.abs(parseFloat(e.additional?.value ?? e.value ?? 0));
    if (!val || isNaN(val)) return;
    const vtype = resolveType(e);
    if (!buckets[vtype]) buckets[vtype] = { accel: [], braking: [], corner: [] };
    const et = (e.type || '').toLowerCase();
    if (et.includes('accel'))                          buckets[vtype].accel.push(val);
    else if (et.includes('brak') || et.includes('brake')) buckets[vtype].braking.push(val);
    else if (et.includes('turn') || et.includes('corner')) buckets[vtype].corner.push(val);
  });

  // Percentil 95
  function p95(arr) {
    if (arr.length < 5) return null;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.ceil(0.95 * s.length) - 1] * 100) / 100;
  }

  const suggestions = {};
  Object.keys(buckets).forEach(vtype => {
    const b = buckets[vtype];
    const s = {};
    const pa = p95(b.accel);   if (pa   != null) s.accel   = pa;
    const pb = p95(b.braking); if (pb   != null) s.braking = pb;
    const pc = p95(b.corner);  if (pc   != null) s.corner  = pc;
    if (Object.keys(s).length) suggestions[vtype] = s;
  });

  showCalibrationResult({ suggestions, topDrivers, totalEvents: events.length });
}

function showCalibrationError(msg) {
  const body = document.getElementById('calibrationBody');
  if (body) body.innerHTML = `<div class="calib-empty"><div class="calib-empty-icon">◎</div><p>${msg}</p></div>`;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCalibration')).show();
  bootstrap.Modal.getInstance(document.getElementById('modalThresholds'))?.hide();
}

function showCalibrationResult({ suggestions, topDrivers, totalEvents }) {
  const body = document.getElementById('calibrationBody');
  if (!body) return;

  const defaultNames = {
    auto:'Automóvil', camioneta:'Camioneta / Pickup', camion:'Camión mediano',
    minibus:'Minibús / Van', bus:'Bus / Autobús', tractomula:'Tractomula / Semi', moto:'Motocicleta'
  };

  const hasSuggestions = Object.keys(suggestions).length > 0;

  const infoHtml = `
  <div class="calib-why">
    <div class="calib-why-header">
      <span class="calib-why-icon">◈</span>
      <span class="calib-why-title">¿Por qué estos valores son distintos a los predeterminados?</span>
    </div>
    <p>Los umbrales predeterminados son una referencia de partida. La calibración va más allá: analiza el comportamiento real de <strong>su flota</strong> para establecer qué es normal en su operación específica.</p>
    <p>Nuestro motor de calibración identifica los patrones de conducción de sus mejores operadores y construye, a partir de sus datos reales, el límite a partir del cual un comportamiento deja de ser normal y se convierte en un evento de riesgo. No es un valor teórico — es un valor derivado de su propia operación, en sus propias rutas, con sus propios vehículos.</p>
    <p class="calib-why-result">Las carreteras de su país tienen características propias. Sus resultados también.</p>
  </div>
  <div class="calib-stats">
    <div class="calib-stat"><span class="calib-stat-val">${topDrivers.length}</span><span class="calib-stat-lbl">Conductores de referencia</span></div>
    <div class="calib-stat"><span class="calib-stat-val">${totalEvents}</span><span class="calib-stat-lbl">Eventos analizados</span></div>
    <div class="calib-stat"><span class="calib-stat-val">P95</span><span class="calib-stat-lbl">Percentil de referencia</span></div>
  </div>`;

  if (!hasSuggestions) {
    body.innerHTML = infoHtml + `<div class="calib-empty"><div class="calib-empty-icon">◎</div><p>No hay suficientes eventos clasificados por tipo de vehículo para generar sugerencias.<br><small>Asigne tipos de vehículo a sus conductores e intente nuevamente.</small></p></div>`;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCalibration')).show();
    bootstrap.Modal.getInstance(document.getElementById('modalThresholds'))?.hide();
    return;
  }

  // Tabla comparativa
  let rows = '';
  Object.keys(suggestions).forEach(vtype => {
    const sug  = suggestions[vtype];
    const cur  = WORKING_THRESHOLDS[vtype] || RECOMMENDED[vtype] || {};
    const name = defaultNames[vtype] || vtype;

    function diffCell(field, unit) {
      if (sug[field] == null) return `<td class="calib-na" colspan="2">—</td>`;
      const diff  = sug[field] - (cur[field] || 0);
      const sign  = diff > 0 ? '+' : '';
      const cls   = Math.abs(diff) < 0.01 ? 'calib-eq' : diff > 0 ? 'calib-up' : 'calib-down';
      const arrow = Math.abs(diff) < 0.01 ? '=' : diff > 0 ? '↑' : '↓';
      return `<td class="calib-cur">${cur[field] ?? '—'}${unit}</td><td class="calib-sug ${cls}"><label class="calib-chk"><input type="checkbox" class="calib-check" data-vtype="${vtype}" data-field="${field}" data-val="${sug[field]}" checked><span>${sug[field]}${unit}</span></label><span class="calib-diff">${arrow} ${sign}${Math.round(diff*100)/100}${unit}</span></td>`;
    }

    rows += `<tr>
      <td class="calib-vname">${name}</td>
      ${diffCell('accel',   'g')}
      ${diffCell('braking', 'g')}
      ${diffCell('corner',  '°')}
    </tr>`;
  });

  body.innerHTML = infoHtml + `
  <div class="calib-table-wrap">
    <table class="calib-table">
      <thead>
        <tr>
          <th>Tipo de vehículo</th>
          <th>Aceleración actual</th><th>Sugerido</th>
          <th>Frenada actual</th><th>Sugerido</th>
          <th>Giro actual</th><th>Sugerido</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="calib-hint">Seleccione los valores que desea aplicar y presione <strong>Aplicar seleccionados</strong>.</p>`;

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCalibration')).show();
  bootstrap.Modal.getInstance(document.getElementById('modalThresholds'))?.hide();
}

function applySelectedCalibration() {
  const checks = document.querySelectorAll('.calib-check:checked');
  if (!checks.length) return;
  checks.forEach(ch => {
    const vtype = ch.dataset.vtype;
    const field = ch.dataset.field;
    const val   = parseFloat(ch.dataset.val);
    if (!WORKING_THRESHOLDS[vtype]) WORKING_THRESHOLDS[vtype] = {};
    WORKING_THRESHOLDS[vtype][field] = val;
  });
  localStorage.setItem('driveiq_thresholds', JSON.stringify(WORKING_THRESHOLDS));
  bootstrap.Modal.getInstance(document.getElementById('modalCalibration'))?.hide();
  // Reabrir modal de umbrales con valores actualizados
  setTimeout(() => {
    openThresholds();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalThresholds')).show();
  }, 350);
}

async function openThresholds() {
  // Cargar los umbrales efectivos del tenant desde el backend (m/s², fuente única).
  try {
    const r = await fetch(`${API_BASE}/config/thresholds?token=${encodeURIComponent(USER_TOKEN)}`);
    if (r.ok) { const d = await r.json(); if (d.status === 'ok' && d.thresholds) WORKING_THRESHOLDS = d.thresholds; }
  } catch (e) { /* si falla, se usa lo cargado en memoria */ }
  if (!WORKING_THRESHOLDS) WORKING_THRESHOLDS = JSON.parse(JSON.stringify(RECOMMENDED));
  const container = document.getElementById('thresholdsEditor');
  if (!container) return;

  const defaultNames = {
    auto:       'Automóvil',
    camioneta:  'Camioneta / Pickup',
    camion:     'Camión mediano',
    minibus:    'Minibús / Van',
    bus:        'Bus / Autobús',
    tractomula: 'Tractomula / Semi',
    moto:       'Motocicleta'
  };

  container.innerHTML = `
  <div class="vtype-naming-notice">
    <div class="vtype-naming-notice-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    </div>
    <div>
      <strong>El mismo vehículo, distintos nombres según el país</strong>
      <p>En cada tarjeta puede personalizar cómo se llama ese tipo de vehículo en su región. El nombre personalizado aparecerá en tablas, reportes y gráficos en lugar del nombre técnico del sistema.</p>
      <p>Esto es útil porque los reportes que se comparten con conductores, supervisores o clientes quedan escritos con el vocabulario que todos reconocen en su país, evitando confusiones. Un reporte que dice <em>"Troca"</em> en México o <em>"Buseta"</em> en Colombia comunica de inmediato de qué vehículo se habla, sin necesidad de interpretarlo. El nombre no afecta el cálculo de umbrales ni el score — solo cambia cómo se muestra en pantalla y en los documentos exportados.</p>
      <div class="vtype-naming-examples">
        <span><strong>Camioneta / Pickup</strong> → en México: <em>Troca</em> · en Colombia: <em>Camioneta doble cabina</em> · en Argentina: <em>Pickup</em></span>
        <span><strong>Tractomula / Semi</strong> → en México: <em>Tráiler</em> · en Colombia: <em>Tractomula</em> · en España: <em>Camión articulado</em></span>
        <span><strong>Minibús / Van</strong> → en Colombia: <em>Buseta</em> · en México: <em>Combi</em> · en Perú: <em>Combi</em> · en Venezuela: <em>Por puesto</em></span>
        <span><strong>Bus / Autobús</strong> → en Colombia: <em>Bus</em> · en México: <em>Camión de pasajeros</em> · en Chile: <em>Micro</em></span>
        <span><strong>Automóvil</strong> → en México: <em>Carro</em> · en Colombia: <em>Carro</em> · en Argentina/Uruguay: <em>Auto</em></span>
      </div>
    </div>
  </div>`;

  for (const k of Object.keys(WORKING_THRESHOLDS)) {
    const threshold = WORKING_THRESHOLDS[k];
    const defaultName = defaultNames[k] || k;
    const customName = VEHICLE_CUSTOM_NAMES[k] || '';

    const displayName = customName || defaultName;
    const html = `
    <div class="vtype-card">
      <div class="vtype-card-top">
        <div class="vtype-card-icon">${VEHICLE_ICONS[k] || ''}</div>
        <div class="vtype-card-info">
          <span class="vtype-tag">${defaultName}</span>
          <div class="vtype-name-field">
            <label class="vtype-name-label">¿Cómo se llama en su país?</label>
            <input type="text" class="vtype-name-input" data-key="${k}" data-field="name" value="${displayName}" maxlength="32" autocomplete="off" spellcheck="false">
          </div>
        </div>
      </div>
      <div class="vtype-thresholds">
        <div class="vtype-th-field">
          <span class="vtype-th-label">Aceleración</span>
          <span class="vtype-th-unit">m/s²</span>
          <input data-key="${k}" data-field="accel" type="number" step="0.1" class="vtype-th-input" value="${threshold.accel || ''}">
        </div>
        <div class="vtype-th-field">
          <span class="vtype-th-label">Frenada</span>
          <span class="vtype-th-unit">m/s²</span>
          <input data-key="${k}" data-field="braking" type="number" step="0.1" class="vtype-th-input" value="${threshold.braking || ''}">
        </div>
        <div class="vtype-th-field">
          <span class="vtype-th-label">Giro</span>
          <span class="vtype-th-unit">m/s²</span>
          <input data-key="${k}" data-field="corner" type="number" step="0.1" class="vtype-th-input" value="${threshold.corner || ''}">
        </div>
      </div>
    </div>`;
    container.insertAdjacentHTML('beforeend', html);
  }
}

async function saveThresholds() {
  const inputs = document.querySelectorAll('#thresholdsEditor input');
  inputs.forEach(inp => {
    const key = inp.getAttribute('data-key');
    const field = inp.getAttribute('data-field');
    if (field === 'name') {
      const val = inp.value.trim();
      if (val) VEHICLE_CUSTOM_NAMES[key] = val;
      else delete VEHICLE_CUSTOM_NAMES[key];
    } else {
      const val = inp.value === '' ? null : parseFloat(inp.value);
      if (!WORKING_THRESHOLDS[key]) WORKING_THRESHOLDS[key] = {};
      WORKING_THRESHOLDS[key][field] = val;
    }
  });
  localStorage.setItem('driveiq_vehicle_names', JSON.stringify(VEHICLE_CUSTOM_NAMES));
  try {
    await fetch(`${API_BASE}/config/thresholds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: USER_TOKEN, thresholds: WORKING_THRESHOLDS })
    });
    localStorage.setItem('driveiq_thresholds', JSON.stringify(WORKING_THRESHOLDS));
  } catch (e) {
    console.error('Error guardando umbrales:', e);
    localStorage.setItem('driveiq_thresholds', JSON.stringify(WORKING_THRESHOLDS));
  }
  bootstrap.Modal.getInstance(document.getElementById('modalThresholds')).hide();
  // Recargar datos para que la severidad de los eventos refleje los nuevos umbrales.
  try {
    if (typeof loadData === 'function') {
      await loadData();
      if (typeof renderInitialState === 'function') renderInitialState();
    }
  } catch (e) { console.error('Recarga tras guardar umbrales:', e); }
  alert(t('save.success'));
}

async function reloadEventsWithFilters() {
  if (!USER_TOKEN) return;
  const from = document.getElementById('startDate').value;
  const to = document.getElementById('endDate').value;
  if (!from || !to) return;
  showLoading(true);
  try {
    const events = await loadEvents(USER_TOKEN, from, to);
    DATA.events = events;
    const driversWithScores = calculateScores(DATA.drivers, events);
    DATA.drivers = driversWithScores;
    renderAll();
  } catch (e) {
    console.error('Error recargando eventos:', e);
    showError('Error al recargar eventos');
  } finally {
    showLoading(false);
  }
}

async function applyQuickRange(range) {
  const endDate = new Date();
  const startDate = new Date();
  let from, to;
  switch (range) {
    case 'today':
      from = to = endDate.toISOString().split('T')[0];
      break;
    case 'yesterday':
      startDate.setDate(startDate.getDate() - 1);
      from = to = startDate.toISOString().split('T')[0];
      break;
    case 'last7':
      startDate.setDate(startDate.getDate() - 7);
      from = startDate.toISOString().split('T')[0];
      to = endDate.toISOString().split('T')[0];
      break;
    case 'last30':
      startDate.setDate(startDate.getDate() - 30);
      from = startDate.toISOString().split('T')[0];
      to = endDate.toISOString().split('T')[0];
      break;
    case 'last_month':
      startDate.setMonth(startDate.getMonth() - 1);
      startDate.setDate(1);
      endDate.setDate(0);
      from = startDate.toISOString().split('T')[0];
      to = endDate.toISOString().split('T')[0];
      break;
    default:
      return;
  }
  document.getElementById('startDate').value = from;
  document.getElementById('endDate').value = to;
}

function applyFilters() {
  if (!DATA || !DATA.events) return;
  
  let filtered = [...DATA.events];
  
  // Aplicar filtros múltiples de conductores
  if (selectedDrivers.size > 0) {
    filtered = filtered.filter(e => e.driver_id && selectedDrivers.has(e.driver_id));
  }
  
  // Aplicar filtros múltiples de vehículos
  if (selectedVehicles.size > 0) {
    // Obtener IDs de conductores que tienen vehículos seleccionados
    const driverIdsFromVehicles = new Set();
    DATA.drivers.forEach(d => {
      if (selectedVehicles.has(d.unit_id)) {
        driverIdsFromVehicles.add(d.driver_id);
      }
    });
    
    // Filtrar eventos por conductores de vehículos seleccionados
    if (driverIdsFromVehicles.size > 0) {
      filtered = filtered.filter(e => {
        if (e.driver_id && driverIdsFromVehicles.has(e.driver_id)) {
          return true;
        }
        // También incluir eventos de vehículos sin conductor si el vehículo está seleccionado
        if (!e.driver_id && e.vehicle_id && selectedVehicles.has(e.vehicle_id)) {
          return true;
        }
        return false;
      });
    } else {
      // Si no hay conductores pero hay vehículos seleccionados, filtrar por vehicle_id
      filtered = filtered.filter(e => {
        if (e.vehicle_id && selectedVehicles.has(e.vehicle_id)) {
          return true;
        }
        // Si el evento tiene unit_id, también verificar
        if (e.unit_id && selectedVehicles.has(e.unit_id)) {
          return true;
        }
        return false;
      });
    }
  }
  
  renderEventsTable(filtered);
  renderChart(filtered);
  
  // También filtrar la tabla de conductores
  renderDriversTable();
}

function generateReport() {
  if (!typesSaved) {
    alert('Debe asignar y guardar los tipos de vehículo antes de generar informes.');
    return;
  }
  applyFilters();
  alert('Informe generado. Use descargas en la ficha del conductor o el botón de exportación masiva.');
}

// ── Manual de usuario ──
let _manualOffcanvas = null;
let _manualRendered = false;

function openManual() {
  if (!_manualOffcanvas) {
    _manualOffcanvas = new bootstrap.Offcanvas(document.getElementById('manualOffcanvas'));
  }
  if (!_manualRendered) {
    renderDriveIQManual();
    _manualRendered = true;
  }
  _manualOffcanvas.show();
}

function renderDriveIQManual() {
  const el = document.getElementById('manualBody');
  if (!el) return;

  function sec(id, icon, colorClass, title, sub, html) {
    return `<div class="man-section" id="man-${id}">
      <div class="man-section-header">
        <div class="man-sico ${colorClass}">${icon}</div>
        <div><h2>${title}</h2><div class="man-sub">${sub}</div></div>
      </div>${html}</div><hr class="man-hr">`;
  }
  function card(title, html) { return `<div class="man-card"><h3>${title}</h3>${html}</div>`; }
  function steps(arr) {
    return '<div class="man-steps">' + arr.map((s,i) =>
      `<div class="man-step"><div class="man-sn">${i+1}</div><div class="man-sb"><strong>${s[0]}</strong><span>${s[1]}</span></div></div>`
    ).join('') + '</div>';
  }
  function g2(a,b) { return `<div class="man-g2">${a}${b}</div>`; }
  function tip(html) { return `<div class="man-tip">${html}</div>`; }
  function warn(html) { return `<div class="man-warn">${html}</div>`; }
  function ft(tag, desc) { return `<div class="man-ft"><span class="man-ft-tag">${tag}</span><span class="man-ft-desc">${desc}</span></div>`; }
  function bx(cls, txt) { return `<span class="man-bx ${cls}">${txt}</span>`; }

  const toc = [
    { id:'navegacion',  icon:'🧭', label:'Navegación' },
    { id:'score',       icon:'📊', label:'Puntuación' },
    { id:'conductores', icon:'👥', label:'Tabla de conductores' },
    { id:'detalle',     icon:'🔎', label:'Detalle del conductor' },
    { id:'eventos',     icon:'⚡', label:'Tipos de eventos' },
    { id:'fuente',      icon:'🛰️', label:'Fuente de datos' },
    { id:'filtros',     icon:'🔍', label:'Filtros' },
    { id:'ranking',     icon:'🏆', label:'Ranking' },
    { id:'coaching',    icon:'✏️', label:'Coaching automático' },
    { id:'indicadores', icon:'💡', label:'Indicadores de impacto' },
    { id:'analisis',    icon:'📈', label:'Análisis de tendencias' },
    { id:'alertas',     icon:'🔔', label:'Alertas en tiempo real' },
    { id:'por100km',    icon:'📏', label:'Eventos por 100 km' },
    { id:'emailrpt',    icon:'📧', label:'Reportes por email' },
    { id:'supervisores',icon:'👤', label:'Roles — Supervisores' },
    { id:'informes',    icon:'📄', label:'Informes' },
    { id:'umbrales',    icon:'⚙️', label:'Umbrales' },
    { id:'perfiles',    icon:'◧',  label:'Perfiles sectoriales' },
    { id:'calibracion', icon:'◈',  label:'Calibración adaptativa' },
    { id:'tipos',       icon:'🚗', label:'Tipos de vehículo' },
    { id:'tema',        icon:'🎨', label:'Tema visual' },
    { id:'pilotos',     icon:'👤', label:'Conductores desde PilotOS' },
    { id:'pwa',         icon:'📱', label:'Instalar como app (PWA)' },
    { id:'comparativa', icon:'📊', label:'Comparativa sectorial' },
  ];

  const tocHtml = `<div class="man-toc">${toc.map(i =>
    `<a href="#man-${i.id}" onclick="document.getElementById('man-${i.id}')?.scrollIntoView({behavior:'smooth',block:'start'});return false">
      <span class="man-toc-icon">${i.icon}</span>${i.label}</a>`
  ).join('')}</div>`;

  const secScore = sec('score','📊','green','Puntuación de conductores','Cómo se calcula el score 0 – 100',
    card('¿Qué mide el score?',
      `<p>Cada conductor comienza con <strong>100 puntos</strong>. Por cada evento de conducción brusca se aplica una penalización según su tipo y severidad.</p>`) +
    card('Escala de puntuación',
      `<div class="man-score-row"><span class="man-score-badge" style="background:rgba(63,185,80,.2);color:#3FB950">90 – 100</span><span style="font-size:.83rem;color:#8B949E">Conducción excelente.</span></div>
       <div class="man-score-row"><span class="man-score-badge" style="background:rgba(47,129,247,.2);color:#2F81F7">75 – 89</span><span style="font-size:.83rem;color:#8B949E">Conducción buena. Algunos eventos leves.</span></div>
       <div class="man-score-row"><span class="man-score-badge" style="background:rgba(245,158,11,.2);color:#D29922">50 – 74</span><span style="font-size:.83rem;color:#8B949E">Conducción aceptable. Requiere atención.</span></div>
       <div class="man-score-row"><span class="man-score-badge" style="background:rgba(248,81,73,.2);color:#F85149">0 – 49</span><span style="font-size:.83rem;color:#8B949E">Conducción riesgosa. Intervención recomendada.</span></div>`) +
    card('Penalizaciones por severidad',
      ft('Leve', `Penalización <strong>0.5×</strong> la base del evento.`) +
      ft('Medio', `Penalización <strong>1.0×</strong> la base del evento.`) +
      ft('Fuerte', `Penalización <strong>1.5×</strong> la base del evento.`)
    )
  );

  const secEventos = sec('eventos','⚡','orange','Tipos de eventos','Qué registra DriveIQ como conducción brusca',
    g2(
      card('⚡ Aceleración brusca',
        `<p>Aumento de velocidad superior al umbral. ${bx('orange','Base: 3 pts')}</p><ul><li>Leve: ratio 1.0–1.3×</li><li>Medio: 1.3–1.6×</li><li>Fuerte: &gt;1.6×</li></ul>`),
      card('🛑 Frenada brusca',
        `<p>Desaceleración brusca superior al umbral. ${bx('red','Base: 3 pts')}</p><ul><li>Leve: ratio 1.0–1.3×</li><li>Medio: 1.3–1.6×</li><li>Fuerte: &gt;1.6×</li></ul>`)
    ) +
    g2(
      card('↩️ Giro brusco',
        `<p>Cambio lateral superior al umbral. ${bx('blue','Base: 2 pts')}</p><ul><li>Leve: ratio 1.0–1.2×</li><li>Medio: 1.2–1.5×</li><li>Fuerte: &gt;1.5×</li></ul>`),
      card('🚨 Exceso de velocidad',
        `<p>Velocidad sobre el límite configurado. ${bx('red','Base: 5 pts')}</p><p>Es el evento de mayor impacto en la puntuación.</p>`)
    ) +
    warn('<strong>Los umbrales son configurables</strong> desde el botón Umbrales en el panel lateral.')
  );

  const secFuente = sec('fuente','🛰️','teal','Fuente de medición','Satélite (GPS) vs Sensor (acelerómetro)',
    g2(
      card('🛰️ GPS / Satélite',
        `<p>Calcula la aceleración a partir del cambio de velocidad. No requiere hardware adicional.</p><p><strong>Umbrales más altos</strong> para evitar falsas alarmas.</p>`),
      card('⚙️ Sensor / Acelerómetro',
        `<p>Mide directamente la fuerza G en cada eje. Mayor precisión y sensibilidad.</p><p><strong>Umbrales más bajos</strong>, detecta eventos menores con confiabilidad.</p>`)
    ) +
    card('¿Cómo identificar la fuente?',
      `<p>Junto al nombre del conductor verá un ícono:</p>
       <ul><li><strong>🛰️</strong> — reporta eventos por GPS/satélite.</li>
       <li><strong>⚙️</strong> — tiene acelerómetro embebido.</li></ul>`)
  );

  const secFiltros = sec('filtros','🔍','purple','Filtros de análisis','Segmentar por vehículo, conductor y período',
    card('Filtros disponibles',
      ft('Vehículos', 'Seleccione uno o varios. Puede marcar grupos completos.') +
      ft('Conductores', 'Filtre por conductor individual para ver su historial.') +
      ft('Fechas', 'Defina rango manual o use atajos: hoy, ayer, últimos 7 días, etc.')
    ) +
    steps([
      ['Seleccionar filtros', 'Marque vehículos y/o conductores en el panel lateral izquierdo.'],
      ['Resultado inmediato', 'Gráficos, tablas y scores se actualizan automáticamente.'],
      ['Exportar', 'Con los filtros activos, use <strong>Generar informe</strong> para exportar.'],
    ])
  );

  const secInformes = sec('informes','📈','teal','Generación de informes','Exportar datos de la flota',
    card('Formatos disponibles',
      ft('PDF', 'Reporte visual con gráficos y tabla de eventos, listo para imprimir.') +
      ft('XLSX', 'Hoja de cálculo con todos los eventos y scores.') +
      ft('CSV', 'Datos en texto plano, compatible con cualquier sistema BI.') +
      ft('JSON', 'Exportación técnica completa para integraciones.')
    ) +
    card('Pasos para generar', steps([
      ['Configure filtros', 'Seleccione vehículos, conductores y rango de fechas.'],
      ['Asigne tipos de vehículo', 'Obligatorio antes de generar. Use el botón <strong>Asignar tipos de vehículo</strong>.'],
      ['Seleccione formatos', 'Active PDF / XLSX / CSV / JSON según necesite.'],
      ['Generar informe', 'Haga clic en <strong>Generar informe</strong> y descargue desde la ficha del conductor.'],
    ])) +
    warn('<strong>Importante:</strong> debe asignar tipos de vehículo al menos una vez antes de exportar.')
  );

  const secUmbrales = sec('umbrales','⚙️','orange','Configuración de umbrales','Ajustar la sensibilidad de detección por tipo de vehículo',
    card('¿Qué son los umbrales?',
      `<p>Son los valores mínimos de fuerza o ángulo a partir de los cuales un movimiento se clasifica como evento brusco. Cada tipo de vehículo tiene su propio conjunto de umbrales porque la física del movimiento es diferente para un auto, un camión de 20 toneladas o una motocicleta.</p>
       <p>Tres parámetros por tipo: <strong>Aceleración</strong> (g) · <strong>Frenada</strong> (g) · <strong>Giro lateral</strong> (°/s)</p>`) +
    card('Valores recomendados — los 7 tipos de vehículo',
      `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">
        <thead><tr style="color:var(--text-secondary);border-bottom:1px solid var(--border-soft)">
          <th style="padding:6px 8px;text-align:left">Tipo</th>
          <th style="padding:6px 8px;text-align:center">Aceleración</th>
          <th style="padding:6px 8px;text-align:center">Frenada</th>
          <th style="padding:6px 8px;text-align:center">Giro</th>
        </tr></thead>
        <tbody>
          <tr style="border-bottom:1px solid var(--border-soft)"><td style="padding:6px 8px;font-weight:600">🚗 Auto</td><td style="text-align:center;padding:6px 8px">0.25 g</td><td style="text-align:center;padding:6px 8px">0.25 g</td><td style="text-align:center;padding:6px 8px">20 °/s</td></tr>
          <tr style="border-bottom:1px solid var(--border-soft)"><td style="padding:6px 8px;font-weight:600">🛻 Camioneta</td><td style="text-align:center;padding:6px 8px">0.22 g</td><td style="text-align:center;padding:6px 8px">0.23 g</td><td style="text-align:center;padding:6px 8px">18 °/s</td></tr>
          <tr style="border-bottom:1px solid var(--border-soft)"><td style="padding:6px 8px;font-weight:600">🚛 Camión</td><td style="text-align:center;padding:6px 8px">0.15 g</td><td style="text-align:center;padding:6px 8px">0.20 g</td><td style="text-align:center;padding:6px 8px">15 °/s</td></tr>
          <tr style="border-bottom:1px solid var(--border-soft)"><td style="padding:6px 8px;font-weight:600">🚐 Minibús</td><td style="text-align:center;padding:6px 8px">0.20 g</td><td style="text-align:center;padding:6px 8px">0.22 g</td><td style="text-align:center;padding:6px 8px">12 °/s</td></tr>
          <tr style="border-bottom:1px solid var(--border-soft)"><td style="padding:6px 8px;font-weight:600">🚌 Bus</td><td style="text-align:center;padding:6px 8px">0.18 g</td><td style="text-align:center;padding:6px 8px">0.22 g</td><td style="text-align:center;padding:6px 8px">10 °/s</td></tr>
          <tr style="border-bottom:1px solid var(--border-soft)"><td style="padding:6px 8px;font-weight:600">🚜 Tractomula</td><td style="text-align:center;padding:6px 8px">0.10 g</td><td style="text-align:center;padding:6px 8px">0.13 g</td><td style="text-align:center;padding:6px 8px">7 °/s</td></tr>
          <tr><td style="padding:6px 8px;font-weight:600">🏍️ Moto</td><td style="text-align:center;padding:6px 8px">0.30 g</td><td style="text-align:center;padding:6px 8px">0.35 g</td><td style="text-align:center;padding:6px 8px">25 °/s</td></tr>
        </tbody>
      </table></div>` +
      tip('Los valores más bajos = más sensible (más eventos detectados). Los valores más altos = menos sensible. Tractomula tiene los umbrales más estrictos; Moto los más permisivos.')
    ) +
    card('Cómo modificarlos',
      steps([
        ['Abrir Umbrales', 'Haga clic en <strong>Umbrales</strong> en el menú superior.'],
        ['Editar valores', 'Cada tipo de vehículo muestra sus tres umbrales editables. Modifique solo los que necesite.'],
        ['Guardar', 'Presione <strong>Guardar</strong>. Los cambios aplican inmediatamente al recalcular scores.'],
        ['Restaurar', 'Use <strong>Valores recomendados</strong> para volver a los valores de la tabla anterior.'],
      ]) +
      warn('Si modifica umbrales con datos históricos cargados, los scores se recalcularán automáticamente con los nuevos valores.')
    )
  );

  const secPerfiles = sec('perfiles','◧','red','Perfiles sectoriales','Configuraciones predefinidas por tipo de operación',
    card('¿Qué son los perfiles sectoriales?',
      `<p>Son configuraciones de umbrales prediseñadas para sectores de operación donde las exigencias de seguridad van más allá del estándar general. No todos los vehículos tienen el mismo nivel de responsabilidad: conducir un camión con carga peligrosa o un bus escolar implica consecuencias radicalmente distintas ante cualquier maniobra brusca.</p>
       <p>Los perfiles sectoriales permiten aplicar con un solo clic los umbrales adecuados para esos contextos, sin necesidad de ajustar cada valor manualmente.</p>`
    ) +
    g2(
      card('Transporte Escolar',
        `<p>Diseñado para cualquier vehículo que transporte pasajeros menores de edad — buses escolares, minibuses, camionetas y vehículos de transporte universitario o de personal.</p>
         <p>En este sector, una frenada brusca puede causar caídas dentro del vehículo, golpes contra los asientos o lesiones en niños que no siempre van con cinturón de seguridad. Los umbrales son los más estrictos del sistema.</p>` +
        ft('Aceleración', 'Máx. 0.10 – 0.12 g según tipo de vehículo') +
        ft('Frenada',     'Máx. 0.12 – 0.14 g') +
        ft('Giro',        'Máx. 7° – 10°') +
        warn('Aplica sobre: Automóvil, Camioneta, Minibús y Bus.')
      ),
      card('Carga Peligrosa',
        `<p>Para vehículos que transportan materiales clasificados como peligrosos: combustibles, químicos, gases a presión, explosivos o cualquier sustancia cuyo derrame represente un riesgo para personas, infraestructura o medio ambiente.</p>
         <p>En este sector el riesgo no recae únicamente en el conductor. Una maniobra brusca puede generar el desplazamiento de la carga, una fuga, un incendio o una emergencia química. Los umbrales son los más bajos del sistema.</p>` +
        ft('Aceleración', 'Máx. 0.06 – 0.08 g según tipo de vehículo') +
        ft('Frenada',     'Máx. 0.08 – 0.10 g') +
        ft('Giro',        'Máx. 5° – 6°') +
        warn('Aplica sobre: Camión mediano y Tractomula.')
      )
    ) +
    card('Cómo aplicar un perfil',
      steps([
        ['Abrir Umbrales', 'Haga clic en <strong>Umbrales</strong> en el menú superior.'],
        ['Perfiles sectoriales', 'Presione el botón <strong>◧ Perfiles sectoriales</strong>.'],
        ['Revisar los valores', 'Cada perfil muestra los umbrales que aplicará y los valores actuales para comparación.'],
        ['Aplicar', 'Presione <strong>Aplicar perfil</strong>. Solo se modifican los tipos de vehículo relevantes — el resto de su flota no se ve afectado.'],
      ]) +
      tip('Los perfiles sectoriales se pueden combinar con la calibración adaptativa: aplique primero el perfil y luego afine con los datos de su flota.')
    ) +
    card('Nota importante',
      `<p>Los perfiles sectoriales establecen umbrales más exigentes que los predeterminados. Esto significa que <strong>se registrarán más eventos</strong> de conducción brusca al inicio, lo cual es el objetivo: visibilizar comportamientos que en otro tipo de operación podrían pasar desapercibidos.</p>
       <p>Si los conductores reciben retroalimentación sobre este cambio, la mejora en los indicadores suele ser notoria en las primeras semanas.</p>`
    )
  );

  const secCalibracion = sec('calibracion','◈','orange','Calibración adaptativa de umbrales','Umbrales ajustados a su operación real',
    card('¿Por qué los valores calibrados son distintos a los predeterminados?',
      `<p>Los umbrales predeterminados de DriveIQ son un punto de partida sólido, pero cada operación es única — y las condiciones de vía de su país son distintas a las de cualquier otra región.</p>
       <p>Las carreteras de montaña exigen frenadas que serían consideradas bruscas en autopistas planas. Una flota que opera en vías sin pavimentar registrará valores naturalmente distintos a una que circula en corredores urbanos. Un conductor de carga nocturna tiene un perfil diferente al de distribución diurna.</p>
       <p>La calibración adaptativa resuelve esto: en lugar de aplicar una tabla genérica, el sistema aprende de <strong>su propia flota, en su propio país</strong>.</p>`
    ) +
    card('Cómo funciona',
      steps([
        ['Análisis de su flota', 'Nuestro motor procesa el historial de conducción de su flota e identifica los patrones de los operadores con mejor desempeño como referencia de conducción normal en su contexto.'],
        ['Construcción del perfil de operación', 'A partir de los registros reales de aceleración, frenada y giro, construye un perfil estadístico de lo que ocurre habitualmente en sus rutas.'],
        ['Determinación del umbral óptimo', 'Establece el punto a partir del cual un comportamiento deja de ser normal y se convierte en un evento de riesgo, basándose exclusivamente en los datos de su operación.'],
        ['Comparativa y decisión', 'Muestra lado a lado el umbral actual y el sugerido. Usted decide cuáles aplicar — puede aceptar todos, algunos o ninguno.'],
      ]) +
      tip('<strong>El resultado:</strong> umbrales que reflejan su realidad operativa — sus rutas, sus vehículos y las condiciones reales de las carreteras de su país.')
    ) +
    card('Requisitos mínimos',
      ft('Conductores', 'Al menos 3 conductores con puntuación registrada en el período analizado.') +
      ft('Eventos', 'Mínimo 20 eventos clasificados. A mayor volumen de datos, mayor precisión.') +
      ft('Tipos asignados', 'Los vehículos deben tener tipo asignado para calibrar por categoría.')
    ) +
    card('Cómo usar la calibración',
      steps([
        ['Abrir Umbrales', 'Haga clic en <strong>Umbrales</strong> en el menú superior.'],
        ['Calibrar con mi flota', 'Presione el botón <strong>✦ Calibrar con mi flota</strong> en la parte inferior del panel.'],
        ['Revisar sugerencias', 'Compare los valores actuales con los sugeridos. Los valores en verde son más permisivos; en rojo, más estrictos.'],
        ['Aplicar selectivamente', 'Marque solo los valores que desea adoptar y presione <strong>Aplicar seleccionados</strong>.'],
      ]) +
      warn('<strong>Recomendación:</strong> realice la primera calibración después de al menos 30 días de operación con datos. A mayor historial, más precisa la calibración.')
    )
  );

  const secTipos = sec('tipos','🚗','blue','Tipos de vehículo','Los 7 tipos disponibles y cómo asignarlos',
    card('¿Para qué sirve el tipo?',
      `<p>El tipo de vehículo determina qué umbrales se aplican al calcular el score. Asignarlo correctamente es fundamental: un camión de 20 toneladas no puede evaluarse con los mismos parámetros que un auto sedán.</p>
       <p>Sin tipo asignado, el sistema usa <strong>Auto</strong> por defecto para todos los vehículos.</p>`
    ) +
    card('Los 7 tipos disponibles',
      ft('🚗 Auto', 'Sedanes, SUV, autos compactos y vehículos de pasajeros livianos. Umbrales: 0.25 g · 0.25 g · 20°/s.') +
      ft('🛻 Camioneta', 'Pick-up, camionetas doble cabina y vehículos utilitarios medianos. Umbrales: 0.22 g · 0.23 g · 18°/s.') +
      ft('🚛 Camión', 'Camiones de carga medianos o pesados. Por su masa e inercia, los umbrales son más estrictos. Umbrales: 0.15 g · 0.20 g · 15°/s.') +
      ft('🚐 Minibús', 'Vans de pasajeros, minibuses de hasta 20 asientos. Enfoque en confort y seguridad de pasajeros de pie. Umbrales: 0.20 g · 0.22 g · 12°/s.') +
      ft('🚌 Bus', 'Buses urbanos, intermunicipales o escolares de gran capacidad. Los umbrales de giro son los más estrictos después de Tractomula. Umbrales: 0.18 g · 0.22 g · 10°/s.') +
      ft('🚜 Tractomula', 'Semirremolques, tráileres y vehículos articulados. Los umbrales más estrictos del sistema por el riesgo de volteo y longitud del vehículo. Umbrales: 0.10 g · 0.13 g · 7°/s.') +
      ft('🏍️ Moto', 'Motocicletas de todo tipo. Umbrales más permisivos porque la física del giro y aceleración es inherentemente diferente. Umbrales: 0.30 g · 0.35 g · 25°/s.')
    ) +
    card('Cómo asignar tipos',
      steps([
        ['Abrir el asignador', 'Haga clic en <strong>Tipos de vehículo</strong> en el menú superior.'],
        ['Buscar vehículo', 'Use el buscador para filtrar por placa o nombre si la flota es grande.'],
        ['Asignación masiva', 'Use los botones de la barra superior para asignar el mismo tipo a toda la flota de un golpe: <strong>Auto · Camioneta · Camión · Minibús · Bus · Tractomula · Moto</strong>.'],
        ['Asignación individual', 'Para cada vehículo, seleccione su tipo en el desplegable de la columna derecha.'],
        ['Guardar', 'Presione <strong>Guardar cambios</strong>. Los scores se recalculan inmediatamente con los umbrales del tipo asignado.'],
      ]) +
      tip('Los tipos se sincronizan con el servidor. Si accede desde otro dispositivo, los tipos ya estarán asignados.')
    ) +
    card('Personalizar el nombre según su país',
      `<p>Cada tipo tiene un nombre técnico en el sistema, pero el mismo vehículo se llama distinto según el país. En la sección <strong>Umbrales</strong>, dentro de cada tarjeta de tipo, encontrará el campo <em>"¿Cómo se llama en su país?"</em> donde puede escribir el nombre local.</p>
       <p>El nombre personalizado reemplaza al técnico en tablas, reportes y documentos exportados. Esto hace que los reportes compartidos con conductores, supervisores o clientes estén escritos con el vocabulario que todos reconocen, sin necesidad de interpretarlo.</p>` +
      ft('Camioneta / Pickup', 'México: <strong>Troca</strong> · Colombia: <strong>Camioneta doble cabina</strong> · Argentina: <strong>Pickup</strong>') +
      ft('Tractomula / Semi', 'México: <strong>Tráiler</strong> · Colombia: <strong>Tractomula</strong> · España: <strong>Camión articulado</strong>') +
      ft('Minibús / Van', 'Colombia: <strong>Buseta</strong> · México / Perú: <strong>Combi</strong> · Venezuela: <strong>Por puesto</strong>') +
      ft('Bus / Autobús', 'México: <strong>Camión de pasajeros</strong> · Chile: <strong>Micro</strong>') +
      ft('Automóvil', 'México / Colombia: <strong>Carro</strong> · Argentina / Uruguay: <strong>Auto</strong>') +
      tip('Cambiar el nombre <strong>no afecta</strong> el cálculo de umbrales ni el score. Es solo una etiqueta visual para reportes y pantallas.')
    ) +
    warn('Sin tipo asignado, todos los vehículos usan <strong>Auto</strong> por defecto. Esto puede inflar o deflactar el score de vehículos pesados como camiones o tractomulas.')
  );

  // ── Secciones nuevas ───────────────────────────────────────────────────────

  const secNavegacion = sec('navegacion','🧭','blue','Navegación','Cómo moverse por DriveIQ',
    card('Barra de secciones (menú secundario)',
      `<p>Justo debajo del menú principal encontrará una barra con botones de acceso rápido a cada sección:</p>` +
      ft('Inicio', 'KPIs principales: puntaje de flota, conductores, eventos y vehículos.') +
      ft('Conductores', 'Tabla de todos los conductores con sus scores y eventos.') +
      ft('Impacto', 'Indicadores de impacto operacional: nocturno, combustible, CO₂, riesgo.') +
      ft('Análisis', 'Gráficos de tendencias históricas de los últimos 6 meses.') +
      ft('Eventos', 'Tabla detallada de todos los eventos del período filtrado.') +
      tip('La sección activa se resalta en naranja. Al hacer clic, la página hace scroll suave hasta ella.')
    ) +
    card('Menú superior (topbar)',
      ft('Umbrales', 'Ajuste la sensibilidad de detección por tipo de vehículo y fuente de datos.') +
      ft('Tipos de vehículo', 'Asigne el tipo a cada unidad de la flota.') +
      ft('Reportes', 'Genere informes exportables en PDF, Excel, CSV o JSON. Desde aquí también se configura el envío automático por email.') +
      ft('Supervisores', 'Cree cuentas de acceso limitado para supervisores de grupo (visible solo para el gerente).') +
      ft('Manual', 'Este manual. Accesible en cualquier momento desde cualquier pantalla.') +
      ft('🔔 Timbre de alertas', 'Icono de notificaciones en tiempo real. El número rojo indica eventos críticos nuevos desde su última revisión.')
    ) +
    card('Menú móvil (barra inferior)',
      `<p>En pantallas pequeñas aparece una barra de navegación en la parte inferior con 5 accesos directos:</p>` +
      ft('Inicio', 'Panel principal.') +
      ft('Conductores', 'Tabla de conductores.') +
      ft('Ranking', 'Clasificación de conductores con podio.') +
      ft('Impacto', 'Indicadores de impacto operacional.') +
      ft('Análisis', 'Tendencias históricas de los últimos 6 meses.')
    ) +
    card('Botón "Subir al menú"',
      `<p>Al hacer scroll hacia abajo más de 400 px, aparece un botón naranja fijo centrado en la parte inferior de la pantalla: <strong>↑ Subir al menú</strong>.</p>` +
      ft('Función', 'Hace scroll suave hasta la parte superior de la página, donde están el topbar y la barra de secciones.') +
      ft('Visibilidad', 'Se oculta automáticamente al volver a la parte superior.') +
      tip('Útil al navegar secciones largas (Ranking, Coaching, Análisis) para volver al menú sin tener que deslizar.')
    )
  );

  const secConductoresTab = sec('conductores','👥','blue','Tabla de conductores','Ver y ordenar el ranking de la flota',
    card('Qué muestra',
      ft('Conductor', 'Nombre del conductor asignado al vehículo.') +
      ft('Vehículo', 'Placa o nombre de la unidad (visible en pantallas grandes).') +
      ft('Tipo', 'Tipo asignado: Auto, Camioneta, Camión, Bus, Moto, etc.') +
      ft('Eventos', 'Total de eventos detectados en el período activo.') +
      ft('Puntuación', 'Score 0–100. Haga clic en el encabezado para ordenar de mayor a menor.')
    ) +
    card('Cómo ordenar y paginar',
      steps([
        ['Ordenar por score', 'Haga clic en el encabezado <strong>Puntuación ▼</strong> para ordenar.'],
        ['Navegar páginas', 'Use el paginador debajo de la tabla si hay más de 20 conductores.'],
        ['Filtrar', 'Use los filtros del panel lateral para mostrar solo los conductores deseados.'],
      ])
    ) +
    card('Íconos de fuente de datos',
      `<p>Junto a cada conductor verá un ícono que indica la fuente de medición:</p>` +
      ft('🛰️', 'Dispositivo GPS/Satélite.') +
      ft('⚙️', 'Dispositivo con acelerómetro embebido.') +
      tip('Al hacer clic en cualquier fila de conductor se abre el panel lateral de detalle.')
    )
  );

  const secDetalle = sec('detalle','🔎','teal','Panel de detalle del conductor','Información individual y exportación',
    card('Cómo abrirlo',
      `<p>Haga clic en cualquier fila de la tabla de conductores. Se abre un panel deslizante desde la derecha.</p>`) +
    card('Qué muestra',
      ft('Nombre y vehículo', 'Encabezado con nombre completo, placa y fuente de datos (🛰️/⚙️).') +
      ft('Puntuación individual', 'Score calculado para el período activo.') +
      ft('Historial de eventos', 'Tabla con todos sus eventos: viaje, tipo, severidad, fecha, velocidad y ubicación.') +
      ft('Servicios vinculados', 'Servicios o etiquetas adicionales asignadas al conductor en GPSwox.')
    ) +
    card('Exportar datos del conductor',
      `<p>En la parte inferior del panel encontrará 4 botones de descarga, todos aplicados únicamente al conductor en vista:</p>` +
      ft('PDF', 'Reporte visual con gráfico y tabla de eventos, listo para imprimir o adjuntar.') +
      ft('Excel', 'Hoja de cálculo con todos sus eventos del período.') +
      ft('CSV', 'Texto separado por comas, compatible con cualquier sistema.') +
      ft('JSON', 'Exportación técnica completa.')
    ) +
    tip('El PDF del conductor incluye el logo y nombre de la empresa si está configurado en GPSwox.')
  );

  const secAnalisis = sec('analisis','📈','teal','Análisis de tendencias','Evolución histórica de la flota — últimos 6 meses',
    card('¿Dónde se encuentra?',
      `<p>Haga clic en el botón <strong>Análisis</strong> en la barra de navegación de secciones (justo debajo del menú principal). También puede seleccionarlo desde el menú inferior en móvil.</p>`) +
    card('Qué muestra esta sección',
      ft('Selector de conductor', 'Elija un conductor específico o deje en "Toda la flota" para ver el agregado.') +
      ft('KPI strip (4 métricas)', 'Score actual · Variación vs mes anterior · % nocturno promedio · Eventos/día.') +
      ft('Evolución del score', 'Gráfico de línea con el score mes a mes durante los últimos 6 meses. Las píldoras de colores debajo muestran rápidamente si cada mes fue bueno, regular o crítico.') +
      ft('Eventos por mes', 'Gráfico de barras que desglosa cuántos eventos hubo por mes.') +
      ft('Semana típica', 'Radar/barra que muestra en qué días de la semana se concentran más eventos. Identifica si los lunes o viernes son más riesgosos.') +
      ft('Conducción nocturna por mes', 'Barra agrupada con el % de eventos nocturnos (20:00–06:00) por mes.') +
      ft('Logros de conductores', 'Insignias automáticas asignadas según comportamiento: Sin eventos, Top 10%, Líder, Mejorando, Manejo diurno, Bajo riesgo.')
    ) +
    card('Cómo se calculan los scores históricos',
      `<p>Para cada mes de los últimos 6, DriveIQ consulta todos los eventos del período y aplica la misma fórmula del score general: <strong>100 − (eventos alto × 5) − (eventos medio × 2)</strong>. Esto permite comparar meses con distintos volúmenes de actividad de forma justa.</p>`) +
    tip('Use el análisis mensual para detectar tendencias antes de tener que intervenir. Un score que cae 3 meses seguidos es una señal de alerta temprana.')
  );

  const secRanking = sec('ranking','🏆','orange','Ranking de conductores','Clasificación gamificada con podio y percentil',
    card('¿Dónde se encuentra?',
      `<p>Haga clic en <strong>Ranking</strong> en la barra de secciones (menú secundario) o en el ícono de barras del menú inferior en móvil.</p>`
    ) +
    card('Podio — Top 3',
      `<p>Los tres mejores conductores del período se muestran en un podio visual con medallas de oro, plata y bronce:</p>` +
      ft('🥇 1° lugar', 'Tarjeta central, más grande, con corona y borde dorado. Muestra nombre, score y percentil dentro de la flota.') +
      ft('🥈 2° lugar', 'Tarjeta izquierda con medalla plata.') +
      ft('🥉 3° lugar', 'Tarjeta derecha con medalla bronce.') +
      tip('El podio se actualiza automáticamente al cambiar el período seleccionado.')
    ) +
    card('Lista completa',
      `<p>Debajo del podio aparece la clasificación completa de todos los conductores con:</p>` +
      ft('Posición (#)', 'Lugar en el ranking, del mejor al peor puntaje.') +
      ft('Conductor', 'Nombre, inicial del avatar y unidad asignada.') +
      ft('Eventos', 'Cantidad de eventos en el período (visible en pantallas grandes).') +
      ft('Percentil', 'Etiqueta TOP X% que indica qué tan arriba está el conductor respecto al resto. <span style="color:#22c55e">TOP 75%+</span> es excelente, <span style="color:#eab308">TOP 25–74%</span> es aceptable, <span style="color:#ef4444">TOP &lt;25%</span> requiere atención.') +
      ft('Score', 'Puntaje numérico con color: verde ≥80, amarillo 60–79, rojo &lt;60.')
    ) +
    card('Selector de período',
      ft('Período activo', 'Usa exactamente los mismos filtros de fechas y vehículos que el resto del panel.') +
      ft('Este mes', 'Recalcula scores usando solo los eventos del mes calendario actual.') +
      ft('Esta semana', 'Recalcula scores usando solo los eventos desde el lunes de la semana actual.') +
      tip('Los períodos "Este mes" y "Esta semana" recalculan el score localmente en el navegador con la fórmula estándar (100 − altos×5 − medios×2), por lo que pueden diferir levemente del score principal que usa todos los filtros activos.')
    ) +
    card('¿Cómo se calcula el percentil?',
      `<p>Fórmula: <strong>((total conductores − posición) / total conductores) × 100</strong>.</p>
       <p>Ejemplo: si hay 20 conductores y un conductor está en el puesto 4, su percentil es ((20−4)/20)×100 = <strong>80%</strong>, es decir, es mejor que el 80% de la flota.</p>`
    )
  );

  const secIndicadores = sec('indicadores','💡','orange','Indicadores de impacto operacional','Sección Impacto — métricas de negocio y conducción nocturna',
    card('¿Dónde se encuentra?',
      `<p>Haga clic en el botón <strong>Impacto</strong> ⚡ de la barra de secciones. La sección muestra 8 tarjetas en dos filas con gradientes de color.</p>`) +
    card('Fila 1 — Conducción nocturna',
      ft('Eventos nocturnos (%)', 'Porcentaje de eventos ocurridos entre las 20:00 y las 06:00 sobre el total del período. La barra de progreso en la tarjeta refleja ese porcentaje.') +
      ft('Nivel de riesgo', 'Clasificación automática: <span style="color:#22c55e">Bajo</span> (&lt;15%) · <span style="color:#eab308">Moderado</span> (15–30%) · <span style="color:#ef4444">Alto</span> (&gt;30%). La tarjeta cambia de color según el nivel.') +
      ft('Eventos / día', 'Promedio diario de eventos en el período activo. Útil para detectar semanas de alta actividad.') +
      ft('Eventos críticos', 'Total de eventos con severidad <strong>alto</strong> y qué porcentaje representan del total.')
    ) +
    card('Fila 2 — Impacto económico y ambiental',
      ft('Litros combustible ahorrado', 'Estimación: cada evento de aceleración o frenada brusca equivale a ~0.8 L de consumo excesivo. Fórmula: (aceleraciones_bruscas + frenadas_bruscas) × 0.8.') +
      ft('kg CO₂ reducidos', 'Estimación ambiental basada en el ahorro de combustible. Factor: 2.31 kg CO₂ por litro de combustible.') +
      ft('Conductores bajo riesgo (%)', 'Porcentaje de conductores que no tuvieron ningún evento de severidad alta en el período.') +
      ft('Score promedio flota', 'Puntaje promedio de todos los conductores activos. La barra refleja el valor sobre 100.')
    ) +
    card('¿Son valores exactos?',
      `<p>Los valores de combustible y CO₂ son <strong>estimaciones orientativas</strong> basadas en estadísticas globales de eficiencia. No reemplazan la telemetría de consumo real. Su función es cuantificar el impacto del comportamiento para motivar la mejora.</p>`
    ) +
    tip('Todos los indicadores se actualizan automáticamente al cambiar el período de fechas o los filtros de vehículos/conductores.')
  );

  const secCoaching = sec('coaching','✏️','green','Coaching automático','Plan de mejora personalizado por conductor',
    card('¿Qué es el Coaching automático?',
      `<p>DriveIQ analiza automáticamente el historial de cada conductor y genera un plan de recomendaciones personalizado basado en sus patrones reales: qué tipo de evento comete más, a qué hora del día, si conduce de noche y con qué frecuencia. No es un mensaje genérico — cada plan refleja el comportamiento específico de ese conductor.</p>`
    ) +
    card('¿Dónde se encuentra?',
      ft('Sección Coaching', 'Haga clic en el botón <strong>Coaching</strong> en la barra de secciones (menú secundario). Muestra las tarjetas de todos los conductores ordenadas por prioridad.') +
      ft('Panel de detalle', 'Al hacer clic en cualquier conductor en la tabla, el panel lateral incluye automáticamente su plan de coaching individual en la parte superior, antes de los botones de descarga.')
    ) +
    card('Niveles de prioridad',
      ft('🔴 Urgente', 'Score menor a 60 <strong>o</strong> 5 o más eventos de severidad alta. Requiere intervención inmediata — retroalimentación directa, posible revisión de ruta o suspensión preventiva.') +
      ft('🟡 Moderado', 'Score menor a 80 <strong>o</strong> 2 o más eventos altos. Conductor que presenta áreas de mejora claras. Un recordatorio o sesión de retroalimentación puede ser suficiente.') +
      ft('🟢 Bueno', 'Score 80 o superior con menos de 2 eventos altos. Conducción aceptable. El plan confirma los hábitos positivos y sugiere mantenerlos.')
    ) +
    card('Qué incluye cada plan',
      ft('Recomendación principal', 'Basada en el tipo de evento más frecuente del conductor (aceleración brusca, frenada, giro o exceso de velocidad). Incluye consejo práctico y accionable.') +
      ft('Conducción nocturna', 'Si más del 20% de sus eventos ocurren entre las 20:00 y las 06:00, el plan incluye una alerta de fatiga con recomendaciones específicas para manejo nocturno.') +
      ft('Hora pico de riesgo', 'Si hay una hora del día con concentración anormal de eventos, el plan señala esa hora y sugiere mayor atención en ese tramo.') +
      ft('Patrón de conducción', 'Resumen del perfil: tipo de evento dominante, hora de mayor riesgo y porcentaje nocturno combinados en una frase descriptiva.')
    ) +
    card('Recomendaciones por tipo de evento',
      ft('⚡ Aceleración brusca', 'Anticipar el tráfico: acercarse al semáforo con el pie levantado, reducir velocidad antes de una curva. Acelerar de forma progresiva en lugar de pisadas cortas y fuertes.') +
      ft('🛑 Frenada brusca', 'Mantener distancia prudencial del vehículo de adelante. La regla de los 3 segundos: desde que el vehículo frente pasa un punto fijo, deben pasar al menos 3 segundos.') +
      ft('↩️ Giro brusco', 'Reducir velocidad antes de entrar a la curva, no dentro de ella. En autopistas, anticipar el cambio de carril con más tiempo.') +
      ft('🚨 Exceso de velocidad', 'Salir 10 minutos antes del horario habitual elimina la necesidad de apresurar la ruta. Programar la entrega con margen de tiempo.')
    ) +
    card('Cómo usar el coaching en la operación',
      steps([
        ['Abrir sección Coaching', 'Haga clic en <strong>Coaching</strong> en la barra de secciones para ver todos los planes.'],
        ['Identificar urgentes', 'Las tarjetas rojas (Urgente) aparecen primero. Son los conductores que necesitan atención inmediata.'],
        ['Ver plan individual', 'Haga clic en cualquier conductor en la tabla de Conductores. El panel lateral muestra su plan completo en la parte superior.'],
        ['Retroalimentar', 'Use el plan como guión para la conversación con el conductor. Muestre el patrón específico detectado.'],
        ['Monitorear mejora', 'Revise el Ranking y el Análisis de tendencias semanas después para medir el impacto de la retroalimentación.'],
      ]) +
      tip('<strong>El coaching es más efectivo cuando se comunica con datos específicos.</strong> Decir "el martes a las 8am tuviste 3 frenadas bruscas" es más accionable que "manejas mal".')
    ) +
    warn('<strong>Los planes se recalculan en cada carga</strong> con los datos del período activo. Al cambiar el filtro de fechas, los patrones y prioridades pueden variar.')
  );

  const secTema = sec('tema','🎨','purple','Tema visual','Modo claro y modo oscuro',
    card('Cambiar el tema',
      `<p>En la esquina superior derecha del topbar encontrará el botón <strong>🌙 Modo oscuro</strong> (o ☀️ Modo claro). Haga clic para alternar entre los dos temas.</p>` +
      ft('Modo oscuro', 'Fondo azul oscuro (#0B1220), ideal para ambientes con poca luz o uso nocturno.') +
      ft('Modo claro', 'Fondo gris claro, ideal para uso en oficina o luz natural.')
    ) +
    card('Persistencia del tema',
      `<p>La preferencia se guarda automáticamente en el navegador (<code>localStorage</code>) y se aplica en la próxima visita sin flash de color.</p>`) +
    tip('El tema afecta todos los gráficos, tablas, modales y cartas de la interfaz en tiempo real.')
  );

  // ── Secciones nuevas Tier 4 ──────────────────────────────────────────────────

  const secPilotos = sec('pilotos','👤','green','Conductores desde PilotOS','Los conductores se gestionan centralmente en PilotOS',
    card('¿Qué es PilotOS?',
      `<p><strong>PilotOS</strong> es el portal de identidad de conductores de la plataforma. Un conductor tiene un solo usuario y contraseña que funciona en DriveIQ, InspectPro y todas las apps del ecosistema.</p>` +
      tip('No es necesario crear conductores en DriveIQ. Se crean en <a href="https://pilotos.gpssoftwarenumberone.com" target="_blank" style="color:var(--accent-blue,#f97316)">pilotos.gpssoftwarenumberone.com</a> y aparecen automáticamente.')
    ) +
    card('Cómo se asocian conductores a vehículos',
      steps([
        ['Abrir PilotOS', 'Ingrese al portal de administración en pilotos.gpssoftwarenumberone.com con su cuenta de GPS.'],
        ['Crear conductor', 'En la sección "Conductores", agregue el nombre, usuario y contraseña del conductor.'],
        ['Asignar vehículo', 'Haga clic en "Asignar vehículo" y seleccione la unidad. El conductor queda vinculado al instante.'],
        ['Ver en DriveIQ', 'Al recargar DriveIQ, el conductor aparece con su nombre real en la tabla de conductores.'],
      ])
    ) +
    card('Vehículos sin conductor asignado',
      `<p>Si un vehículo no tiene conductor asignado en PilotOS, DriveIQ muestra su placa con el texto <strong style="color:#b45309">Sin conductor · Asígnelo en PilotOS</strong>. El enlace lo lleva directamente al portal para hacer la asignación.</p>` +
      warn('DriveIQ <strong>no gestiona conductores directamente</strong>. Si un conductor no aparece, verifique que esté creado y con vehículo asignado en PilotOS.')
    ) +
    card('Asignación QR (entrada/salida)',
      ft('QR por conductor', 'Cada conductor tiene un código QR único. Al escanearlo, se registra la entrada al turno y el vehículo queda asignado automáticamente.') +
      ft('Check-out', 'Al terminar el turno, el conductor vuelve a escanear el QR para cerrar la asignación.') +
      ft('Reset de turno', 'PilotOS puede configurarse para cerrar automáticamente las asignaciones a una hora específica (ej. medianoche).')
    )
  );

  const secPwa = sec('pwa','📱','blue','Instalar como app (PWA)','Acceso rápido desde el celular sin descargar nada de la tienda',
    card('¿Qué es una PWA?',
      `<p>DriveIQ es una <strong>Progressive Web App</strong>. Esto significa que puede instalarse en el celular o computador y abrirse como si fuera una app nativa, sin pasar por App Store ni Google Play.</p>` +
      tip('Una vez instalada, DriveIQ abre a pantalla completa sin barra de navegador y aparece en el escritorio del dispositivo.')
    ) +
    card('Instalar en Android (Chrome)',
      steps([
        ['Abrir DriveIQ en Chrome', 'Vaya a driveiq.gpssoftwarenumberone.com/driveiq desde el navegador Chrome.'],
        ['Menú de Chrome', 'Toque los tres puntos (⋮) en la esquina superior derecha.'],
        ['Agregar a pantalla de inicio', 'Seleccione "Agregar a pantalla de inicio" o "Instalar aplicación".'],
        ['Confirmar', 'Toque "Agregar". El ícono de DriveIQ aparecerá en su pantalla de inicio.'],
      ])
    ) +
    card('Instalar en iPhone / iPad (Safari)',
      steps([
        ['Abrir en Safari', 'Vaya a la URL de DriveIQ desde Safari (no Chrome en iOS).'],
        ['Botón compartir', 'Toque el ícono de compartir (cuadrado con flecha hacia arriba) en la barra inferior.'],
        ['Agregar a pantalla', 'Seleccione "Agregar a pantalla de inicio".'],
        ['Confirmar', 'Toque "Agregar". El ícono aparecerá en su pantalla de inicio.'],
      ])
    ) +
    card('Instalar en computador (Chrome / Edge)',
      `<p>En el escritorio, Chrome y Edge muestran un ícono de instalación en la barra de dirección (⊕ o ícono de pantalla). Haga clic para instalar DriveIQ como aplicación de escritorio.</p>` +
      ft('Acceso directo', 'Se crea un ícono en el escritorio y en el menú de aplicaciones.') +
      ft('Sin navegador visible', 'Abre en ventana propia sin pestañas ni barra de dirección.')
    ) +
    card('Modo sin conexión',
      `<p>DriveIQ incluye un <strong>Service Worker</strong> que guarda en caché los archivos estáticos. Esto permite abrir la app aunque no haya internet, aunque los datos de flota no estarán disponibles hasta restablecer la conexión.</p>`
    )
  );

  const secComparativaSec = sec('comparativa','📊','purple','Comparativa sectorial','Compare el rendimiento de su flota contra benchmarks del sector',
    card('¿Dónde se encuentra?',
      `<p>Haga clic en <strong>Comparativa</strong> en la barra de secciones (menú secundario). La sección aparece entre "Análisis" y "Eventos".</p>`
    ) +
    card('¿Qué muestra?',
      ft('Selector de sector', 'Elija el sector de referencia más cercano a su operación: Logística y distribución, Transporte escolar, Carga pesada, Transporte ejecutivo, o Campo / minería.') +
      ft('Score de su flota vs benchmark', 'Compara el score promedio de su flota contra el promedio del sector seleccionado. Indicador verde si supera el benchmark, rojo si está por debajo.') +
      ft('Eventos por 100 km', 'Frecuencia de incidentes normalizada por distancia, comparada contra el estándar del sector.') +
      ft('Desglose por tipo de evento', 'Frenadas, aceleraciones y excesos de velocidad comparados con las tasas del sector.') +
      tip('Use la comparativa para contextualizar los resultados. Un score de 70 puede ser excelente en carga pesada y mediocre en transporte ejecutivo.')
    ) +
    card('Sectores disponibles',
      ft('Logística y distribución', 'Score referencia: 74 · Foco en frenadas y aceleraciones frecuentes por paradas cortas.') +
      ft('Transporte escolar', 'Score referencia: 82 · Los estándares más estrictos del sistema — seguridad de pasajeros vulnerables.') +
      ft('Carga pesada', 'Score referencia: 70 · Vehículos con alta inercia, frenadas y excesos de velocidad son el mayor riesgo.') +
      ft('Transporte ejecutivo', 'Score referencia: 85 · Confort y puntualidad. Tolerancia mínima a eventos de cualquier tipo.') +
      ft('Campo / minería', 'Score referencia: 68 · Condiciones de terreno difícil generan más eventos por naturaleza.')
    ) +
    warn('Los benchmarks son promedios sectoriales de referencia basados en estándares internacionales. No representan datos de otras flotas de sus clientes.')
  );

  el.innerHTML = `
    <div class="man-hero">
      <span class="man-rbadge">🛰️ GPS</span>
      <span class="man-rbadge" style="background:rgba(63,185,80,.15);color:#86efac">⚙️ Sensor</span>
      <h1>DriveIQ</h1>
      <p>Plataforma de análisis de conducción e inteligencia de flota. Mide, clasifica y reporta el comportamiento de cada conductor.</p>
    </div>
    ${tocHtml}
    ${secNavegacion}
    ${secScore}
    ${secConductoresTab}
    ${secDetalle}
    ${secEventos}
    ${secFuente}
    ${secFiltros}
    ${secRanking}
    ${secCoaching}
    ${secIndicadores}
    ${secAnalisis}
    ${secInformes}
    ${secUmbrales}
    ${secPerfiles}
    ${secCalibracion}
    ${secTipos}
    ${secTema}
    ${secPilotos}
    ${secPwa}
    ${secComparativaSec}
  `;
}

// ── Secciones Tier 3 del manual ───────────────────────────────────────────────
// Se agregan fuera de renderDriveIQManual para no superar límite de función,
// pero se inyectan como variables locales en el scope del render vía patch.
(function patchManualTier3() {
  const _orig = renderDriveIQManual;
  window.renderDriveIQManual = function() {
    // Ejecutar original para que el HTML quede montado
    _orig();
    const el = document.getElementById('manualBody');
    if (!el) return;

    function sec(id, icon, colorClass, title, sub, html) {
      return `<div class="man-section" id="man-${id}">
        <div class="man-section-header">
          <div class="man-sico ${colorClass}">${icon}</div>
          <div><h2>${title}</h2><div class="man-sub">${sub}</div></div>
        </div>${html}</div><hr class="man-hr">`;
    }
    function card(title, html) { return `<div class="man-card"><h3>${title}</h3>${html}</div>`; }
    function steps(arr) {
      return '<div class="man-steps">' + arr.map((s,i) =>
        `<div class="man-step"><div class="man-sn">${i+1}</div><div class="man-sb"><strong>${s[0]}</strong><span>${s[1]}</span></div></div>`
      ).join('') + '</div>';
    }
    function tip(html) { return `<div class="man-tip">${html}</div>`; }
    function warn(html) { return `<div class="man-warn">${html}</div>`; }
    function ft(tag, desc) { return `<div class="man-ft"><span class="man-ft-tag">${tag}</span><span class="man-ft-desc">${desc}</span></div>`; }

    const secAlertas = sec('alertas','🔔','orange','Alertas en tiempo real','Notificaciones automáticas de eventos críticos mientras la app está abierta',
      card('¿Cómo funciona?',
        `<p>Cuando DriveIQ está abierto, el sistema consulta automáticamente si hay eventos nuevos cada <strong>60 segundos</strong>. Si detecta eventos desde su última revisión, aparece una notificación sin necesidad de recargar la página.</p>` +
        tip('La consulta solo ocurre mientras la pestaña está activa. En segundo plano no consume recursos.')
      ) +
      card('El timbre de alertas 🔔',
        `<p>En la esquina superior derecha del menú hay un icono de timbre. Cuando hay alertas sin leer, aparece un número rojo sobre el timbre.</p>` +
        ft('Haga clic en 🔔', 'Se abre el panel de alertas con el listado de eventos nuevos.') +
        ft('Marcar leídas', 'Borra el contador y el listado de alertas del panel.') +
        ft('Cierre automático', 'El panel se cierra al hacer clic fuera de él.')
      ) +
      card('Niveles de alerta',
        ft('🔴 Crítico', 'Uso del teléfono, fatiga, somnolencia o cinturón desabrochado. Genera sonido de doble tono y fondo rojo en el panel.') +
        ft('🟡 Moderado', 'Exceso de velocidad, frenada brusca, aceleración brusca, curva brusca. Genera un tono suave y fondo neutro.')
      ) +
      card('Notificación emergente (toast)',
        `<p>Además del panel, cada vez que llega un evento nuevo aparece brevemente una notificación en la esquina inferior derecha de la pantalla indicando el nombre del conductor y el tipo de evento.</p>`
      ) +
      warn('Las alertas en tiempo real solo funcionan mientras DriveIQ está abierto en el navegador. No son notificaciones push del sistema operativo.')
    );

    const secPor100km = sec('por100km','📏','teal','Eventos por 100 km','Métrica de eficiencia que normaliza los eventos por distancia recorrida',
      card('¿Por qué es importante?',
        `<p>El número total de eventos no es justo para comparar conductores con diferentes cargas de trabajo. Un conductor que hace 400 km al día tendrá más eventos que uno que hace 50 km, aunque conduzca mejor. <strong>Eventos por 100 km</strong> normaliza la cantidad de incidentes por distancia recorrida, dando una comparación equitativa.</p>`
      ) +
      card('¿Cómo se calcula la distancia?',
        ft('Odómetro GPS', 'Si el vehículo tiene sensor de odómetro configurado en la plataforma GPS, se usa ese valor. Es la fuente más precisa.') +
        ft('Estimación GPS', 'Si no hay odómetro, el sistema calcula la distancia sumando las distancias entre las posiciones GPS de los eventos consecutivos del vehículo. Es una estimación mínima — la distancia real siempre es mayor.') +
        ft('N/D', 'Si no hay suficientes datos GPS, la columna muestra "N/D".')
      ) +
      card('¿Dónde aparece?',
        `<p>La métrica se muestra en el panel de detalle de cada conductor al abrirlo desde la tabla. Aparece junto al score y la comparativa vs flota.</p>` +
        tip('Un buen resultado es por debajo de 2 eventos/100km. Entre 2 y 5 requiere atención. Por encima de 5 es conducción riesgosa.')
      ) +
      warn('La estimación GPS es un mínimo: no mide los trayectos entre eventos. El número real de km recorridos siempre es mayor que la estimación.')
    );

    const secEmailRpt = sec('emailrpt','📧','blue','Reportes por email','Envío automático o manual de resúmenes de flota al correo',
      card('Acceder a la configuración',
        steps([
          ['Abrir el menú Reportes', 'Haga clic en <strong>Reportes</strong> en el menú superior.'],
          ['Botón de email', 'Al final del panel de reportes encontrará el botón <strong>📧 Configurar envío por email</strong>.'],
          ['Llenar los datos SMTP', 'Ingrese el servidor, puerto, usuario y contraseña del correo de envío.'],
          ['Destinatario', 'El email al que se enviarán los reportes (puede ser el mismo de envío o uno diferente).'],
          ['Guardar y probar', 'Haga clic en <strong>Guardar config</strong> y luego <strong>Enviar ahora</strong> para verificar que funciona.'],
        ])
      ) +
      card('Contenido del reporte',
        ft('Score promedio de flota', 'Número de conductores, eventos totales y puntaje promedio general.') +
        ft('Top 5 — Mejor desempeño', 'Los 5 conductores con mejor score del período.') +
        ft('Requieren atención', 'Los 5 conductores con menor score, para intervención prioritaria.') +
        ft('Eventos más frecuentes', 'Tabla con los 8 tipos de evento más comunes y su frecuencia.')
      ) +
      card('Envío automático',
        ft('Diario', 'Se envía todos los días a las 8:00 a.m.') +
        ft('Semanal', 'Se envía los lunes a las 8:00 a.m.') +
        ft('Mensual', 'Se envía el día 1 de cada mes a las 8:00 a.m.') +
        tip('Para que el envío automático funcione, DriveIQ debe haber estado abierto al menos una vez para registrar el token de acceso en el servidor. Si la app no ha sido abierta ese día, el envío se omite.')
      ) +
      card('Configuración SMTP recomendada',
        ft('Gmail', 'smtp.gmail.com · Puerto 587 · TLS. Use una <strong>contraseña de aplicación</strong> (no la contraseña normal). Actívela en Seguridad → Contraseñas de aplicaciones de su cuenta Google.') +
        ft('Outlook / Hotmail', 'smtp-mail.outlook.com · Puerto 587 · TLS.') +
        ft('Yahoo', 'smtp.mail.yahoo.com · Puerto 465 · SSL.')
      )
    );

    const secSupervisores = sec('supervisores','👤','green','Roles — Supervisores','Acceso limitado por grupo de vehículos para supervisores de zona o turno',
      card('¿Para qué sirve?',
        `<p>El gerente o administrador principal tiene acceso a toda la flota. Los <strong>supervisores</strong> son usuarios adicionales que solo ven los vehículos y conductores que les fueron asignados — útil cuando hay diferentes zonas, turnos o encargados de grupo.</p>`
      ) +
      card('Crear un supervisor',
        steps([
          ['Abrir Supervisores', 'Haga clic en <strong>Supervisores</strong> en el menú superior (solo visible para el gerente principal).'],
          ['Llenar los datos', 'Ingrese nombre, email y contraseña para el nuevo supervisor.'],
          ['Asignar vehículos', 'Seleccione los vehículos de su grupo (Ctrl+clic para seleccionar varios). Sin selección, tendrá acceso a todos.'],
          ['Crear', 'Haga clic en <strong>Crear supervisor</strong>. El supervisor ya puede ingresar.'],
        ]) +
        tip('El supervisor recibe un acceso independiente. Cambiar su contraseña o eliminarlo no afecta la cuenta del gerente.')
      ) +
      card('Cómo ingresa el supervisor',
        `<p>El supervisor abre la misma URL de DriveIQ pero añadiendo <code>?supervisor=1</code> al final. Verá una pantalla de login diferente donde ingresa con su email y contraseña.</p>` +
        ft('URL de ejemplo', 'driveiq.gpssoftwarenumberone.com/driveiq/?supervisor=1') +
        tip('Comparta este enlace directamente con el supervisor. Puede marcarlo como favorito en su navegador.')
      ) +
      card('Vista del supervisor',
        `<p>Una vez autenticado, el supervisor ve DriveIQ con un banner naranja en la parte superior indicando su nombre y cuántos vehículos tiene asignados. Solo verá datos de esos vehículos y sus conductores. Las secciones de gestión de supervisores no están disponibles para él.</p>` +
        ft('Salir de la vista', 'El botón <strong>Salir</strong> en el banner devuelve a la pantalla de login de supervisor.')
      ) +
      warn('El gerente puede ver y eliminar supervisores en cualquier momento desde el panel de Supervisores.')
    );

    // Insertar las 7 secciones antes de #man-informes
    const informesEl = el.querySelector('#man-informes');
    if (informesEl) {
      const wrapper = document.createElement('div');
      const secROI2 = sec("roi","💰","orange","Calculadora de ROI","Estime el ahorro anual con DriveIQ",tip("Ingrese km/mes, precio combustible y mejora esperada.")+ card("ROI","<p>Ahorro combustible + mantenimiento + riesgo vs costo mensual.</p>"+ft("Acceso","Menú → ROI")));const secRetos2 = sec("retos","🏁","teal","Retos de desempeño","Competencias entre conductores",tip("Compare scores entre conductores o vs promedio de flota.")+card("Crear reto","<p>Sección Retos: nombre, conductor 1, rival, fecha fin.</p>"+ft("Tip","Muéstrelo en reuniones de flota.")));const secVVD2 = sec("vehiculovs","🚗","purple","Vehículo vs Conductor","Diagnóstico operador vs unidad",tip("Cruza score del vehículo con scores de conductores asignados en PilotOS.")+card("Lectura","<ul><li>Vehículo mejor: problema del conductor.</li><li>Conductor mejor: revisión mecánica.</li></ul>"+ft("Requisito","Conductores asignados en PilotOS.")));const secRastreo = sec("rastreo","📍","green","Rastreo de conductores","Ubicación en tiempo real del conductor desde su propio teléfono",card("¿Qué hace?","<p>Permite ver la ubicación en tiempo real de cada conductor directamente desde su celular. Una vez activo, el conductor aparece en el panel de seguimiento de flota junto con los demás vehículos, sin necesidad de ningún dispositivo adicional.</p>")+card("¿Cómo se activa?",steps([["Ir a PilotOS","Abra el panel de conductores en PilotOS."],["Abrir el detalle del conductor","Haga clic en el conductor que desea rastrear."],["Activar el rastreo","En la sección Rastreo de ubicación, haga clic en Activar y confirme."]]))+warn("Para desactivar el rastreo de un conductor se debe enviar una solicitud de baja — no es posible cancelarlo directamente desde la plataforma. Esto garantiza que el servicio quede correctamente registrado.")+tip("El costo mensual por conductor rastreado es el mismo por unidad que sus dispositivos de seguimiento activos. Aplica desde el día de activación."));wrapper.innerHTML = secAlertas + secPor100km + secEmailRpt + secSupervisores + secROI2 + secRetos2 + secVVD2 + secRastreo;
      while (wrapper.firstChild) informesEl.parentNode.insertBefore(wrapper.firstChild, informesEl);
    }
  };
})();
// ══════════════════════════════════════════════════════════════════════════════
// SECCIÓN ANÁLISIS — Tendencias, semana típica, nocturna, insignias
// ══════════════════════════════════════════════════════════════════════════════

let _scoreTrendChart   = null;
let _eventsTrendChart  = null;
let _weekPatternChart  = null;
let _nightByMonthChart = null;

function _destroyChart(inst) {
  if (inst) { try { inst.destroy(); } catch(e) {} }
  return null;
}

function _chartTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    text:   dark ? '#8B949E' : '#6c757d',
    grid:   dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)',
    bg:     dark ? '#0F1A2E' : '#ffffff',
    amber:  '#F97316',
    red:    dark ? '#FF453A' : '#dc3545',
    green:  dark ? '#3FB950' : '#198754',
    blue:   dark ? '#58A6FF' : '#0d6efd',
  };
}

// ── Build last 6 months metadata ──────────────────────────────────────────────
function _buildMonths() {
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const from = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
    const to   = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    const label = d.toLocaleDateString('es', { month: 'short' }).replace('.','')
      .replace(/^\w/, c => c.toUpperCase());
    months.push({ from, to, label });
  }
  return months;
}

// ── Main loader ───────────────────────────────────────────────────────────────
async function loadAnalisisData(driverId) {
  const token = USER_TOKEN;
  if (!token) return;

  const months = _buildMonths();

  // Fetch all months in parallel
  const results = await Promise.allSettled(
    months.map(m => loadEvents(token, m.from, m.to).catch(() => []))
  );

  const monthData = results.map((r, i) => {
    const raw = r.status === 'fulfilled' ? (Array.isArray(r.value) ? r.value : []) : [];
    const evs = driverId ? raw.filter(e => e.driver_id === driverId) : raw;
    const altos  = evs.filter(e => e.severity === 'alto').length;
    const medios = evs.filter(e => e.severity === 'medio').length;
    const score  = evs.length === 0 ? 100 : Math.max(0, Math.min(100, 100 - altos * 5 - medios * 2));
    const nightEvs = evs.filter(e => { const h = new Date(e.ts).getHours(); return h >= 20 || h < 6; });
    const nightPct = evs.length > 0 ? Math.round((nightEvs.length / evs.length) * 100) : 0;
    return { label: months[i].label, events: evs.length, score, nightPct, rawEvs: evs };
  });

  // Week pattern from all months combined
  const weekCounts = Array(7).fill(0);
  monthData.forEach(m => m.rawEvs.forEach(e => {
    const d = new Date(e.ts);
    if (!isNaN(d.getTime())) weekCounts[d.getDay()]++;
  }));

  // KPI strip values
  const lastScore  = monthData[5]?.score ?? 0;
  const prevScore  = monthData[4]?.score ?? lastScore;
  const scoreDelta = lastScore - prevScore;
  const avgNight   = Math.round(monthData.reduce((s, m) => s + m.nightPct, 0) / monthData.length);
  const totalEvts  = monthData.reduce((s, m) => s + m.events, 0);
  const evPerDay   = (totalEvts / 180).toFixed(1); // 6 months ≈ 180 days

  const th = _chartTheme();

  // Update KPI strip
  const set = (id, val, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (color) el.style.color = color;
  };
  set('analisisScoreVal',  lastScore,  th.amber);
  set('analisisTrendVal',  (scoreDelta >= 0 ? '+' : '') + scoreDelta + ' pts',
      scoreDelta >= 0 ? th.green : th.red);
  set('analisisNightVal',  avgNight + '%',
      avgNight >= 30 ? th.red : avgNight >= 15 ? '#f59e0b' : th.green);
  set('analisisEventsVal', evPerDay, th.amber);

  // Trend badge
  const badgeEl = document.getElementById('analisisScoreTrendBadge');
  if (badgeEl) {
    badgeEl.textContent = scoreDelta >= 0
      ? '▲ Mejorando +' + scoreDelta + ' pts'
      : '▼ Bajando ' + scoreDelta + ' pts';
    badgeEl.className = 'diq-trend-badge ' + (scoreDelta >= 0 ? 'diq-trend-up' : 'diq-trend-down');
  }

  // Month score pills
  const pillsEl = document.getElementById('scoreTrendPills');
  if (pillsEl) {
    pillsEl.innerHTML = monthData.map((m, i) => `
      <div class="diq-month-pill ${i === 5 ? 'is-current' : ''}">
        <div class="diq-month-pill-score">${m.score}</div>
        <div class="diq-month-pill-label">${m.label}</div>
      </div>
    `).join('');
  }

  // Charts
  _renderScoreTrend(monthData, th);
  _renderEventsTrend(monthData, th);
  _renderWeekPattern(weekCounts, th);
  _renderNightByMonth(monthData, th);

  // Badges (only fleet view)
  if (!driverId) _renderBadges(monthData);
}

// ── Score trend chart ─────────────────────────────────────────────────────────
function _renderScoreTrend(data, th) {
  _scoreTrendChart = _destroyChart(_scoreTrendChart);
  const ctx = document.getElementById('scoreTrendChart');
  if (!ctx) return;
  _scoreTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(m => m.label),
      datasets: [{
        label: 'Score',
        data: data.map(m => m.score),
        borderColor: th.amber,
        backgroundColor: th.amber + '22',
        borderWidth: 2.5,
        pointBackgroundColor: th.amber,
        pointBorderColor: th.bg,
        pointBorderWidth: 2,
        pointRadius: 5,
        tension: 0.4,
        fill: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          min: 0, max: 100,
          grid: { color: th.grid },
          ticks: { color: th.text, font: { size: 11 } },
        },
        x: {
          grid: { display: false },
          ticks: { color: th.text, font: { size: 11 } },
        },
      },
    },
  });
}

// ── Events trend chart ────────────────────────────────────────────────────────
function _renderEventsTrend(data, th) {
  _eventsTrendChart = _destroyChart(_eventsTrendChart);
  const ctx = document.getElementById('eventsTrendChart');
  if (!ctx) return;
  _eventsTrendChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(m => m.label),
      datasets: [{
        label: 'Eventos',
        data: data.map(m => m.events),
        backgroundColor: th.red + 'CC',
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: th.grid },
          ticks: { color: th.text, font: { size: 11 } },
        },
        x: {
          grid: { display: false },
          ticks: { color: th.text, font: { size: 11 } },
        },
      },
    },
  });
}

// ── Week pattern chart ────────────────────────────────────────────────────────
function _renderWeekPattern(counts, th) {
  _weekPatternChart = _destroyChart(_weekPatternChart);
  const ctx = document.getElementById('weekPatternChart');
  if (!ctx) return;
  const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const max = Math.max(...counts);
  const bgColors = counts.map(c => c === max && max > 0 ? th.amber + 'EE' : th.amber + '55');
  _weekPatternChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{ label: 'Eventos', data: counts, backgroundColor: bgColors, borderRadius: 5 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: th.grid }, ticks: { color: th.text, font: { size: 10 } } },
        x: { grid: { display: false }, ticks: { color: th.text, font: { size: 10 } } },
      },
    },
  });
  // Worst day message
  const worstEl = document.getElementById('worstDayMsg');
  if (worstEl && max > 0) {
    worstEl.textContent = `Los ${days[counts.indexOf(max)]} concentran más eventos (${max})`;
  }
}

// ── Night by month chart ──────────────────────────────────────────────────────
function _renderNightByMonth(data, th) {
  _nightByMonthChart = _destroyChart(_nightByMonthChart);
  const ctx = document.getElementById('nightByMonthChart');
  if (!ctx) return;
  const bgColors = data.map(m =>
    m.nightPct >= 30 ? th.red + 'CC' : m.nightPct >= 15 ? '#f59e0b' + 'CC' : th.green + 'CC'
  );
  _nightByMonthChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(m => m.label),
      datasets: [{ label: '% Nocturno', data: data.map(m => m.nightPct), backgroundColor: bgColors, borderRadius: 5 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, max: 100, grid: { color: th.grid }, ticks: { color: th.text, font: { size: 10 }, callback: v => v + '%' } },
        x: { grid: { display: false }, ticks: { color: th.text, font: { size: 10 } } },
      },
    },
  });
  const avg = Math.round(data.reduce((s, m) => s + m.nightPct, 0) / data.length);
  const nightEl = document.getElementById('nightSummaryMsg');
  if (nightEl) nightEl.textContent = `Promedio: ${avg}% nocturno en los últimos 6 meses`;
}

// ── Badges ────────────────────────────────────────────────────────────────────
function _renderBadges(monthData) {
  const grid = document.getElementById('badgesGrid');
  if (!grid || !DATA) return;

  const drivers  = DATA.drivers  || [];
  const allEvts  = DATA.events   || [];
  const sortedD  = [...drivers].sort((a, b) => b.score - a.score);
  const total    = sortedD.length;

  if (total === 0) { grid.innerHTML = '<p class="text-muted small">Sin conductores.</p>'; return; }

  const lastMonthEvts = monthData[5]?.rawEvs ?? [];
  const prevMonthEvts = monthData[4]?.rawEvs ?? [];

  grid.innerHTML = sortedD.map((d, rank) => {
    const dEvts    = lastMonthEvts.filter(e => e.driver_id === d.driver_id);
    const prevEvts = prevMonthEvts.filter(e => e.driver_id === d.driver_id);
    const percentile = total > 0 ? Math.round(((total - (rank + 1)) / total) * 100) : 0;

    const nightEvts  = dEvts.filter(e => { const h = new Date(e.ts).getHours(); return h >= 20 || h < 6; });
    const nightPct   = dEvts.length > 0 ? Math.round((nightEvts.length / dEvts.length) * 100) : 0;
    const improving  = prevEvts.length > 0 && dEvts.length < prevEvts.length;
    const altoCount  = dEvts.filter(e => e.severity === 'alto').length;

    const badges = [];
    if (dEvts.length === 0)    badges.push({ cls: 'diq-badge-chip-green',  icon: '🛡', txt: 'Sin eventos' });
    if (percentile >= 90)      badges.push({ cls: 'diq-badge-chip-gold',   icon: '🏆', txt: 'Top 10%' });
    if (rank === 0)            badges.push({ cls: 'diq-badge-chip-gold',   icon: '⭐', txt: 'Líder' });
    if (improving)             badges.push({ cls: 'diq-badge-chip-blue',   icon: '📈', txt: 'Mejorando' });
    if (nightPct < 10 && dEvts.length > 0) badges.push({ cls: 'diq-badge-chip-purple', icon: '☀️', txt: 'Manejo diurno' });
    if (altoCount === 0 && dEvts.length > 0) badges.push({ cls: 'diq-badge-chip-green', icon: '✅', txt: 'Bajo riesgo' });

    const chipsHtml = badges.length > 0
      ? badges.map(b => `<span class="diq-badge-chip ${b.cls}">${b.icon} ${b.txt}</span>`).join('')
      : `<span class="diq-badge-no-badges">Sin logros este período</span>`;

    return `
      <div class="diq-badge-row">
        <div class="diq-badge-driver-name" title="${d.name}">${d.name}</div>
        <div class="diq-badge-chips">${chipsHtml}</div>
      </div>
    `;
  }).join('');
}

// ── Section nav active state ───────────────────────────────────────────────────
function _updateSectionNavActive(section) {
  document.querySelectorAll('.diq-snav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });
}

// ── Intersection observer para actualizar nav activo al hacer scroll ──────────
(function() {
  const sectionMap = {
    heroRow:          'inicio',
    driversSection:   'conductores',
    analisisSection:  'analisis',
    eventsSection:    'eventos',
  };
  if (!('IntersectionObserver' in window)) return;
  const obs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const section = sectionMap[entry.target.id];
        if (section) _updateSectionNavActive(section);
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  document.addEventListener('DOMContentLoaded', () => {
    Object.keys(sectionMap).forEach(id => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
  });
})();

// ── Patch scrollToSection to include analisis ─────────────────────────────────
(function() {
  const _orig = typeof scrollToSection === 'function' ? scrollToSection : null;
  window.scrollToSection = function(section) {
    const targets = {
      inicio:       '#heroRow',
      conductores:  '#driversSection',
      analisis:     '#analisisSection',
      comparativa:  '#benchmarkingSection',
      eventos:      '#eventsSection',
      reportes:     '#sidebarPanel',
    };
    const el = document.querySelector(targets[section]);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      _updateSectionNavActive(section);
    } else if (_orig) {
      _orig(section);
    }
  };
})();

// ── Populate driver select + trigger load ─────────────────────────────────────
function initAnalisis() {
  const sel = document.getElementById('analisisDriverSelect');
  if (!sel) return;

  // Populate options
  sel.innerHTML = '<option value="">Toda la flota</option>';
  if (DATA && DATA.drivers) {
    [...DATA.drivers].sort((a, b) => b.score - a.score).forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.driver_id;
      opt.textContent = d.name;
      sel.appendChild(opt);
    });
  }

  // On change
  sel.onchange = () => loadAnalisisData(sel.value || null);

  // Initial load
  loadAnalisisData(null);
}

// ── Hook into existing data load cycle ───────────────────────────────────────
// After DATA is populated, init the analysis section.
// We patch the existing render pipeline by observing when DATA is ready.
(function() {
  const _checkInterval = setInterval(() => {
    if (DATA && DATA.drivers && DATA.drivers.length > 0) {
      clearInterval(_checkInterval);
      setTimeout(initAnalisis, 500);
    }
  }, 1000);
  // Fallback: also hook into DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (DATA && DATA.drivers && DATA.drivers.length > 0) initAnalisis();
    }, 3000);
  });
})();

// ══════════════════════════════════════════════════════════════════════════════
// SECCIÓN INDICADORES DE IMPACTO OPERACIONAL
// ══════════════════════════════════════════════════════════════════════════════

function renderIndicadoresSection() {
  if (!DATA || !DATA.events || !DATA.events.length) return;
  const events = DATA.events;
  const total  = events.length;
  if (total === 0) return;

  const $ = id => document.getElementById(id);
  const setTxt = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  // — Período —
  const startEl = $('startDate'), endEl = $('endDate');
  let days = 30, periodLabel = 'Período actual';
  if (startEl && endEl && startEl.value && endEl.value) {
    days = Math.max(1, Math.round((new Date(endEl.value) - new Date(startEl.value)) / 86400000));
    const fmt = d => { const [y,m,day] = d.split('-'); return `${day}/${m}/${y.slice(2)}`; };
    periodLabel = `${fmt(startEl.value)} – ${fmt(endEl.value)}`;
  }
  setTxt('impPeriodBadge', t(periodLabel));
  setTxt('impDaysSub', t('Período de {n} días').replace('{n}', days));

  // — Nocturno —
  const nightEvs = events.filter(e => { const h = new Date(e.ts).getHours(); return h >= 20 || h < 6; });
  const nightPct = Math.round((nightEvs.length / total) * 100);
  setTxt('impNightPct',   nightPct + '%');
  setTxt('impNightCount', t('{n} de {t} total').replace('{n}', nightEvs.length).replace('{t}', total));
  const nightBar = $('impNightBar');
  if (nightBar) nightBar.style.width = Math.min(100, nightPct) + '%';

  // riesgo nocturno — card dinámica
  const riskCard = $('impNightRiskCard');
  const riskLabel = nightPct >= 30 ? 'Alto' : nightPct >= 15 ? 'Moderado' : 'Bajo';
  setTxt('impNightRisk', t(riskLabel));
  if (riskCard) {
    riskCard.classList.remove('risk-yellow','risk-red');
    if (nightPct >= 30)       riskCard.classList.add('risk-red');
    else if (nightPct >= 15)  riskCard.classList.add('risk-yellow');
  }

  // — Eventos/día —
  setTxt('impEvDay', (total / days).toFixed(1));

  // — Eventos críticos —
  const highRiskEvs = events.filter(e => (e.severity||'').toLowerCase() === 'alto').length;
  setTxt('impHighRisk',    highRiskEvs);
  setTxt('impHighRiskPct', t('{n}% del total').replace('{n}', Math.round(highRiskEvs / total * 100)));

  // — Combustible / CO₂ —
  const hardAccel   = events.filter(e => e.type === 'hard_acceleration').length;
  const hardBraking = events.filter(e => e.type === 'hard_braking').length;
  const fuelSaved   = ((hardAccel + hardBraking) * 0.8).toFixed(1);
  const co2Saved    = Math.round(fuelSaved * 2.31);
  setTxt('impFuel', fuelSaved + ' L');
  setTxt('impCo2',  co2Saved  + ' kg');

  // — Conductores bajo riesgo —
  const driversHighRisk = new Set(events.filter(e => (e.severity||'').toLowerCase()==='alto').map(e=>e.driver_id));
  const totalDrivers = DATA.drivers ? DATA.drivers.length : 0;
  const lowRiskCount = totalDrivers - driversHighRisk.size;
  const lowRiskPct   = totalDrivers > 0 ? Math.round(lowRiskCount / totalDrivers * 100) : 0;
  setTxt('impLowRisk',      lowRiskPct + '%');
  setTxt('impLowRiskCount', t('{n} sin eventos críticos').replace('{n}', lowRiskCount));

  // — Score promedio —
  const avgScore = DATA.drivers && DATA.drivers.length > 0
    ? Math.round(DATA.drivers.reduce((s,d) => s + (d.score||0), 0) / DATA.drivers.length) : 0;
  setTxt('impScore', avgScore);
  const scoreBar = $('impScoreBar');
  if (scoreBar) scoreBar.style.width = avgScore + '%';

  // Mostrar sección
  const sec = $('indicadoresSection');
  if (sec) sec.style.display = '';
}

// Enganchar al ciclo de datos
(function() {
  const _indInterval = setInterval(() => {
    if (DATA && DATA.events && DATA.events.length > 0) {
      clearInterval(_indInterval);
      renderIndicadoresSection();
    }
  }, 800);
})();

// Parche scrollToSection para incluir 'indicadores'
(function() {
  const _origScroll = window.scrollToSection;
  window.scrollToSection = function(section) {
    if (section === 'indicadores') {
      renderIndicadoresSection();
      const el = document.getElementById('indicadoresSection');
      if (el) {
        el.style.display = '';
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      }
      document.querySelectorAll('.diq-snav-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.section === 'indicadores')
      );
      document.querySelectorAll('.mob-nav-item').forEach(b =>
        b.classList.remove('active')
      );
    } else if (typeof _origScroll === 'function') {
      _origScroll(section);
    }
  };
})();

// ══════════════════════════════════════════════════════════════════════════════
// SECCIÓN RANKING — Podio + lista completa con percentil
// ══════════════════════════════════════════════════════════════════════════════

let _rankingPeriod = 'current'; // 'current' | 'month' | 'week'

function _getRankedDrivers(period) {
  if (!DATA || !DATA.drivers || !DATA.drivers.length) return [];

  if (period === 'current') {
    // Usa los datos ya cargados con el filtro activo
    return [...DATA.drivers].sort((a, b) => b.score - a.score);
  }

  // Para month/week: recalcula scores desde DATA.events filtrando por fecha
  const now   = new Date();
  let fromMs;
  if (period === 'week') {
    const day  = now.getDay() || 7;
    fromMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1).getTime();
  } else { // month
    fromMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }

  const periodEvs = (DATA.events || []).filter(e => {
    const t = new Date(e.ts).getTime();
    return !isNaN(t) && t >= fromMs;
  });

  const scoreMap = {};
  const evMap    = {};
  periodEvs.forEach(e => {
    const id = e.driver_id;
    if (!scoreMap[id]) { scoreMap[id] = 100; evMap[id] = 0; }
    evMap[id]++;
    const sev = (e.severity || '').toLowerCase();
    if (sev === 'alto')  scoreMap[id] -= 5;
    if (sev === 'medio') scoreMap[id] -= 2;
  });

  return DATA.drivers
    .map(d => ({
      ...d,
      score:        Math.max(0, scoreMap[d.driver_id] !== undefined ? scoreMap[d.driver_id] : 100),
      events_count: evMap[d.driver_id] || 0,
    }))
    .sort((a, b) => b.score - a.score);
}

function _scoreClass(score) {
  return score >= 80 ? 'diq-score-good' : score >= 60 ? 'diq-score-mid' : 'diq-score-bad';
}
function _scoreColor(score) {
  return score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';
}
function _percentilePillClass(pct) {
  return pct >= 75 ? 'diq-rank-pill-green' : pct >= 25 ? 'diq-rank-pill-yellow' : 'diq-rank-pill-red';
}

function renderRankingSection(period) {
  period = period || _rankingPeriod;
  const drivers = _getRankedDrivers(period);
  if (!drivers.length) return;

  const total = drivers.length;

  // ── Podio ────────────────────────────────────────────────────────────────
  const podium  = document.getElementById('rankingPodium');
  const top3    = drivers.slice(0, 3);
  // Orden visual: 2° | 1° | 3°
  const podOrder = [1, 0, 2];
  const rankMeta = [
    { label: '🥇 1°', avatarCls: 'diq-pod-avatar-1', rankCls: 'diq-pod-rank-1', first: true  },
    { label: '🥈 2°', avatarCls: 'diq-pod-avatar-2', rankCls: 'diq-pod-rank-2', first: false },
    { label: '🥉 3°', avatarCls: 'diq-pod-avatar-3', rankCls: 'diq-pod-rank-3', first: false },
  ];

  if (podium) {
    podium.innerHTML = podOrder.map(idx => {
      const d = top3[idx];
      if (!d) return '<div></div>';
      const pos      = idx + 1;
      const pctNum   = Math.round(((total - pos) / total) * 100);
      const pctCls   = _percentilePillClass(pctNum);
      const m        = rankMeta[idx];
      const sc       = _scoreColor(d.score);
      const firstName = (d.name || '').split(' ')[0];
      return `
      <div class="diq-pod-card${m.first ? ' diq-pod-first' : ''}">
        ${m.first ? '<span class="diq-pod-crown">👑</span>' : ''}
        <span class="diq-pod-rank ${m.rankCls}">${m.label}</span>
        <div class="diq-pod-avatar ${m.avatarCls}">${(d.name||'?').charAt(0).toUpperCase()}</div>
        <div class="diq-pod-name" title="${d.name}">${firstName}</div>
        <div class="diq-pod-score" style="color:${sc}">${Math.round(d.score)}</div>
        <span class="diq-pod-percentile ${pctCls}">TOP ${pctNum}%</span>
        <div class="diq-pod-vehicle">${d.unit_id || ''}</div>
      </div>`;
    }).join('');
  }

  // ── Lista completa (pos 4+) ──────────────────────────────────────────────
  const tbody = document.getElementById('rankingTbody');
  if (tbody) {
    tbody.innerHTML = drivers.map((d, i) => {
      const pos    = i + 1;
      const pctNum = Math.round(((total - pos) / total) * 100);
      const pctCls = _percentilePillClass(pctNum);
      const scCls  = _scoreClass(d.score);
      const evs    = d.events_count !== undefined ? d.events_count : (DATA.events||[]).filter(e=>e.driver_id===d.driver_id).length;
      return `<tr>
        <td class="align-middle"><span class="diq-rank-pos">${pos}</span></td>
        <td class="align-middle">
          <div style="display:flex;align-items:center;gap:9px">
            <span class="diq-rank-avatar">${(d.name||'?').charAt(0).toUpperCase()}</span>
            <div>
              <div class="diq-rank-name">${d.name || '—'}</div>
              <div class="diq-rank-unit">${d.unit_id || ''}</div>
            </div>
          </div>
        </td>
        <td class="align-middle d-none d-md-table-cell">
          <span class="diq-rank-unit">${d.unit_id || '—'}</span>
        </td>
        <td class="align-middle text-center d-none d-lg-table-cell">
          <span class="diq-rank-unit">${evs}</span>
        </td>
        <td class="align-middle text-center">
          <span class="diq-rank-pill ${pctCls}">TOP ${pctNum}%</span>
        </td>
        <td class="align-middle text-center">
          <span class="diq-rank-score-badge ${scCls}">${Math.round(d.score)}</span>
        </td>
      </tr>`;
    }).join('');
  }

  // Mostrar sección
  const sec = document.getElementById('rankingSection');
  if (sec) sec.style.display = '';
}

function switchRankPeriod(period, btn) {
  _rankingPeriod = period;
  document.querySelectorAll('.diq-rpt-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderRankingSection(period);
}

// Parche scrollToSection para 'ranking' e 'impacto' (móvil)
(function() {
  const _origScroll2 = window.scrollToSection;
  window.scrollToSection = function(section) {
    if (section === 'ranking') {
      renderRankingSection(_rankingPeriod);
      const el = document.getElementById('rankingSection');
      if (el) { el.style.display = ''; setTimeout(() => el.scrollIntoView({ behavior:'smooth', block:'start' }), 50); }
      document.querySelectorAll('.diq-snav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === 'ranking'));
      document.querySelectorAll('.mob-nav-item').forEach(b => b.classList.toggle('active', b.textContent.trim() === 'Ranking'));
    } else {
      if (typeof _origScroll2 === 'function') _origScroll2(section);
    }
  };
  // mobileNavTo patch para nuevos items
  const _origMobNav = window.mobileNavTo;
  window.mobileNavTo = function(section, btn) {
    if (section === 'ranking') {
      document.querySelectorAll('.mob-nav-item').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      scrollToSection('ranking');
    } else if (section === 'impacto') {
      document.querySelectorAll('.mob-nav-item').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      scrollToSection('indicadores');
    } else if (section === 'analisis') {
      document.querySelectorAll('.mob-nav-item').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      scrollToSection('analisis');
    } else if (typeof _origMobNav === 'function') {
      _origMobNav(section, btn);
    }
  };
})();

// Enganchar al ciclo de datos
(function() {
  const _rankInterval = setInterval(() => {
    if (DATA && DATA.drivers && DATA.drivers.length > 0) {
      clearInterval(_rankInterval);
      // Pre-render silencioso para que al hacer click aparezca rápido
      renderRankingSection('current');
    }
  }, 850);
})();

// ══════════════════════════════════════════════════════════════════════════════
// PLAN DE COACHING AUTOMÁTICO
// ══════════════════════════════════════════════════════════════════════════════

const _COACHING_TIPS = {
  hard_acceleration: [
    { ico: '⚡', ico_bg: 'rgba(249,115,22,.15)', ico_color: '#f97316',
      title: 'Aceleración brusca',
      text: 'Anticipe el tráfico con más distancia. Acelere progresivamente en lugar de pisar a fondo — el consumo de combustible se reduce hasta un 15% y el desgaste de frenos disminuye.' },
  ],
  hard_braking: [
    { ico: '🛑', ico_bg: 'rgba(239,68,68,.15)', ico_color: '#ef4444',
      title: 'Frenada brusca',
      text: 'Mantenga distancia de seguridad de al menos 3 segundos con el vehículo de adelante. Anticipe semáforos y reduzca velocidad antes de llegar a ellos.' },
  ],
  hard_cornering: [
    { ico: '↩️', ico_bg: 'rgba(59,130,246,.15)', ico_color: '#3b82f6',
      title: 'Giro brusco',
      text: 'Reduzca velocidad antes de ingresar a la curva, no durante. Gire el volante con suavidad y mantenga la trayectoria estable para evitar volteos.' },
  ],
  overspeed: [
    { ico: '🚨', ico_bg: 'rgba(239,68,68,.15)', ico_color: '#ef4444',
      title: 'Exceso de velocidad',
      text: 'Salir 10 minutos antes reduce la necesidad de compensar tiempo con velocidad. El riesgo de accidente grave se cuadruplica al superar el límite en más de 20 km/h.' },
  ],
};

const _NIGHT_TIP = {
  ico: '🌙', ico_bg: 'rgba(129,140,248,.15)', ico_color: '#818cf8',
  title: 'Conducción nocturna elevada',
  text: 'Más del 30% de sus eventos ocurren entre las 20:00 y las 06:00. El riesgo de accidente nocturno es 3× mayor por fatiga y menor visibilidad. Considere pausas obligatorias o rotación de turno.'
};

const _PEAK_HOURS_TIP = (hour) => ({
  ico: '⏰', ico_bg: 'rgba(245,158,11,.15)', ico_color: '#f59e0b',
  title: t('Hora pico de riesgo: {h}:00–{h2}:00').replace('{h}', hour).replace('{h2}', hour+1),
  text: t('La mayoría de sus eventos se concentran alrededor de las {h}:00 h. Si corresponde a hora pico de tráfico, planificar rutas alternativas o salir 15 min antes puede reducir eventos a la mitad.').replace('{h}', hour)
});

const _DAY_TIPS = {
  0: 'domingo', 1: 'lunes', 2: 'martes', 3: 'miércoles',
  4: 'jueves',  5: 'viernes', 6: 'sábado'
};

function _buildCoachingPlan(driverId) {
  const events  = (DATA.events || []).filter(e => e.driver_id === driverId);
  const driver  = (DATA.drivers || []).find(d => d.driver_id === driverId);
  if (!events.length || !driver) return null;

  const total = events.length;
  const score = Math.round(driver.score || 0);

  // Conteo por tipo
  const typeCounts = {};
  const hourCounts = new Array(24).fill(0);
  const dayCounts  = new Array(7).fill(0);
  let nightCount = 0;

  events.forEach(e => {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    const d = new Date(e.ts);
    if (!isNaN(d)) {
      hourCounts[d.getHours()]++;
      dayCounts[d.getDay()]++;
      const h = d.getHours();
      if (h >= 20 || h < 6) nightCount++;
    }
  });

  // Tipo más frecuente
  const topType   = Object.entries(typeCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const topHour   = hourCounts.indexOf(Math.max(...hourCounts));
  const topDay    = dayCounts.indexOf(Math.max(...dayCounts));
  const nightPct  = Math.round(nightCount / total * 100);
  const altoCount = events.filter(e => (e.severity||'').toLowerCase() === 'alto').length;

  // Prioridad
  let priority = 'good';
  if (score < 60 || altoCount >= 5) priority = 'urgent';
  else if (score < 80 || altoCount >= 2) priority = 'moderate';

  const priorityLabel = { urgent: t('Urgente'), moderate: t('Moderado'), good: t('Buen nivel') };

  // Construir tips (máx 3)
  const tips = [];
  if (topType && _COACHING_TIPS[topType]) tips.push(..._COACHING_TIPS[topType]);
  if (nightPct >= 30) tips.push(_NIGHT_TIP);
  if (tips.length < 3 && hourCounts[topHour] > total * 0.3) tips.push(_PEAK_HOURS_TIP(topHour));
  // Relleno si buen nivel
  if (tips.length === 0) {
    tips.push({ ico:'✅', ico_bg:'rgba(34,197,94,.15)', ico_color:'#22c55e',
      title:'Conducción dentro de parámetros',
      text:'El conductor no muestra patrones de riesgo predominantes en el período. Mantener el ritmo y reforzar positivamente.' });
  }

  // Patrón resumen
  const patternParts = [];
  if (topType) patternParts.push(t('Evento más frecuente: {ev} ({n})').replace('{ev}', '<strong>' + t(_evLabel(topType)) + '</strong>').replace('{n}', typeCounts[topType]));
  if (dayCounts[topDay] > 0) patternParts.push(t('Día con más eventos: {d}').replace('{d}', '<strong>' + t(_DAY_TIPS[topDay]) + '</strong>'));
  if (nightPct > 0) patternParts.push(t('Nocturno: {n}').replace('{n}', '<strong>' + nightPct + '%</strong>'));

  return { driver, score, priority, priorityLabel: priorityLabel[priority], tips: tips.slice(0,3), pattern: patternParts.join(' · '), total, altoCount };
}

function _evLabel(type) {
  const map = {
    hard_acceleration:'Aceleración brusca', hard_braking:'Frenada brusca',
    hard_cornering:'Giro brusco', overspeed:'Exceso velocidad',
    acceleration:'Aceleración', braking:'Frenada', corner:'Curva',
  };
  return map[type] || type;
}

function _coachCardHTML(plan) {
  if (!plan) return '';
  const sc = plan.score >= 80 ? '#22c55e' : plan.score >= 60 ? '#f59e0b' : '#ef4444';
  const tipsHTML = plan.tips.map(tip => `
    <div class="diq-coach-tip">
      <div class="diq-coach-tip-ico" style="background:${tip.ico_bg};color:${tip.ico_color}">${tip.ico}</div>
      <div><strong>${t(tip.title)}:</strong> ${t(tip.text)}</div>
    </div>`).join('');

  return `
  <div class="diq-coach-card priority-${plan.priority}">
    <div class="diq-coach-header">
      <div class="diq-coach-avatar">${(plan.driver.name||'?').charAt(0).toUpperCase()}</div>
      <div class="diq-coach-name" title="${plan.driver.name}">${plan.driver.name}</div>
      <span class="diq-coach-score" style="color:${sc}">${plan.score}</span>
      <span class="diq-coach-priority-pill pill-${plan.priority}">${plan.priorityLabel}</span>
    </div>
    <div class="diq-coach-tips">${tipsHTML}</div>
    ${plan.pattern ? `<div class="diq-coach-pattern">${plan.pattern} · ${t('{n} eventos ({c} críticos)').replace('{n}', plan.total).replace('{c}', plan.altoCount)}</div>` : ''}
  </div>`;
}

function renderCoachingSection() {
  if (!DATA || !DATA.drivers || !DATA.drivers.length) return;

  const grid = document.getElementById('coachingGrid');
  if (!grid) return;

  // Ordenar: urgentes primero, luego por score asc
  const plans = DATA.drivers
    .map(d => _buildCoachingPlan(d.driver_id))
    .filter(Boolean)
    .sort((a, b) => {
      const order = { urgent: 0, moderate: 1, good: 2 };
      if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
      return a.score - b.score;
    });

  grid.innerHTML = plans.map(_coachCardHTML).join('') || '<p class="text-muted">No hay datos suficientes para generar recomendaciones.</p>';

  const sec = document.getElementById('coachingSection');
  if (sec) sec.style.display = '';
}

// Inyectar coaching en offcanvas de detalle conductor
function renderDriverCoaching(driverId) {
  const block = document.getElementById('driverCoachingBlock');
  if (!block) return;
  const plan = _buildCoachingPlan(driverId);
  if (!plan || !plan.tips.length) { block.innerHTML = ''; return; }

  const tipsHTML = plan.tips.map(tip => `
    <div class="diq-oc-tip">
      <span style="font-size:.9rem">${tip.ico}</span>
      <div><strong style="color:var(--text-primary)">${t(tip.title)}:</strong> ${t(tip.text)}</div>
    </div>`).join('');

  block.innerHTML = `
    <div class="diq-offcanvas-coaching">
      <div class="diq-offcanvas-coaching-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        ${t('Plan de coaching personalizado')}
        <span class="diq-coach-priority-pill pill-${plan.priority}" style="margin-left:auto">${plan.priorityLabel}</span>
      </div>
      ${tipsHTML}
    </div>`;
}

// Parche openDriverDetailById para incluir coaching
(function() {
  const _origOpen = window.openDriverDetailById;
  window.openDriverDetailById = async function(id) {
    if (typeof _origOpen === 'function') await _origOpen(id);
    renderDriverCoaching(id);
  };
})();

// Parche scrollToSection para 'coaching'
(function() {
  const _origS3 = window.scrollToSection;
  window.scrollToSection = function(section) {
    if (section === 'coaching') {
      renderCoachingSection();
      const el = document.getElementById('coachingSection');
      if (el) { el.style.display=''; setTimeout(()=>el.scrollIntoView({behavior:'smooth',block:'start'}),50); }
      document.querySelectorAll('.diq-snav-btn').forEach(b => b.classList.toggle('active', b.dataset.section==='coaching'));
      document.querySelectorAll('.mob-nav-item').forEach(b => b.classList.remove('active'));
    } else if (typeof _origS3==='function') { _origS3(section); }
  };
})();

// Enganchar al ciclo de datos
(function() {
  const _ci = setInterval(() => {
    if (DATA && DATA.drivers && DATA.drivers.length > 0) {
      clearInterval(_ci);
      renderCoachingSection();
    }
  }, 900);
})();

// ── Comparativa conductor vs flota (panel de detalle) ─────────────────────────
function renderDriverComparativa(driverId) {
  const block = document.getElementById('detailScoreBlock');
  if (!block) return;

  const driver  = DATA.drivers.find(d => d.driver_id === driverId);
  if (!driver) return;

  const allScores = DATA.drivers.map(d => d.score).filter(s => typeof s === 'number');
  const avgFlota  = allScores.length ? Math.round(allScores.reduce((a,b) => a+b, 0) / allScores.length) : null;
  const total     = allScores.length;
  const rank      = allScores.filter(s => s > driver.score).length; // cuántos tienen más score
  const percentil = total > 1 ? Math.round(((total - rank - 1) / (total - 1)) * 100) : 100;

  // Tendencia: comparar eventos últimas 2 semanas vs 2 semanas anteriores
  const now      = Date.now();
  const w2       = 14 * 86400000;
  const driverEvents = DATA.events.filter(e => e.driver_id === driverId);
  const recent   = driverEvents.filter(e => now - new Date(e.ts).getTime() < w2).length;
  const anterior = driverEvents.filter(e => {
    const age = now - new Date(e.ts).getTime();
    return age >= w2 && age < w2 * 2;
  }).length;

  let trendIco = '→', trendTxt = 'Estable', trendColor = 'var(--text-secondary, #8b949e)';
  if (recent < anterior && anterior > 0) {
    trendIco = '↑'; trendTxt = 'Mejorando'; trendColor = '#3fb950';
  } else if (recent > anterior && anterior > 0) {
    trendIco = '↓'; trendTxt = 'Empeorando'; trendColor = '#f85149';
  }

  // Colores
  const scoreColor  = driver.score >= 80 ? '#3fb950' : driver.score >= 60 ? '#f97316' : '#f85149';
  const pctColor    = percentil >= 75 ? '#3fb950' : percentil >= 40 ? '#f97316' : '#f85149';
  const diffVal     = avgFlota != null ? driver.score - avgFlota : null;
  const diffSign    = diffVal > 0 ? '+' : '';
  const diffColor   = diffVal > 0 ? '#3fb950' : diffVal < 0 ? '#f85149' : '#8b949e';

  block.innerHTML = `
    <div class="diq-comp-row">
      <div class="diq-comp-score-main">
        <div class="diq-comp-score-num" style="color:${scoreColor}">${driver.score}</div>
        <div class="diq-comp-score-label">${t('Puntuación')}</div>
      </div>
      <div class="diq-comp-stats">
        ${avgFlota != null ? `
        <div class="diq-comp-stat">
          <div class="diq-comp-stat-val" style="color:${diffColor}">${t('{n} vs flota').replace('{n}', diffSign + diffVal)}</div>
          <div class="diq-comp-stat-sub">${t('Promedio flota: {n}').replace('{n}', avgFlota)}</div>
        </div>` : ''}
        <div class="diq-comp-stat">
          <div class="diq-comp-stat-val" style="color:${pctColor}">${t('Top {n}%').replace('{n}', 100 - percentil)}</div>
          <div class="diq-comp-stat-sub">${t('Percentil {p} · Puesto {r} de {t}').replace('{p}', percentil).replace('{r}', rank + 1).replace('{t}', total)}</div>
        </div>
        <div class="diq-comp-stat">
          <div class="diq-comp-stat-val" style="color:${trendColor}">${trendIco} ${t(trendTxt)}</div>
          <div class="diq-comp-stat-sub">${t('Últimas 2 semanas')}</div>
        </div>
        <div class="diq-comp-stat">
          <div class="diq-comp-stat-val">${renderEventsPerKmBadge(driverId)}</div>
          <div class="diq-comp-stat-sub">${t('Densidad de eventos')}</div>
        </div>
      </div>
    </div>`;
}

// Inyectar en el parche existente
(function() {
  const _prev = window.openDriverDetailById;
  window.openDriverDetailById = async function(id) {
    if (typeof _prev === 'function') await _prev(id);
    renderDriverComparativa(id);
  };
})();

// ── Benchmarking sectorial ────────────────────────────────────────────────────
const BENCH_REFERENCE = {
  logistica:  { label: 'Logística y distribución', score: 74, eventos_100k: 4.2, frenadas: 1.8, aceleraciones: 1.2, velocidad: 0.9 },
  escolar:    { label: 'Transporte escolar',        score: 82, eventos_100k: 2.1, frenadas: 0.9, aceleraciones: 0.7, velocidad: 0.3 },
  carga:      { label: 'Carga pesada',              score: 70, eventos_100k: 5.1, frenadas: 2.4, aceleraciones: 1.8, velocidad: 1.4 },
  ejecutivo:  { label: 'Transporte ejecutivo',      score: 85, eventos_100k: 1.8, frenadas: 0.8, aceleraciones: 0.6, velocidad: 0.5 },
  campo:      { label: 'Campo / minería',           score: 68, eventos_100k: 6.3, frenadas: 3.1, aceleraciones: 2.2, velocidad: 2.0 },
};

function renderBenchmarking() {
  const grid = document.getElementById('benchmarkingGrid');
  if (!grid) return;
  const sector = document.getElementById('benchSectorSelect')?.value || 'logistica';
  const ref    = BENCH_REFERENCE[sector];
  if (!ref || !DATA.drivers.length) { grid.innerHTML = '<p class="text-muted small">' + t('Sin datos suficientes.') + '</p>'; return; }

  const scores       = DATA.drivers.map(d => d.score).filter(s => typeof s === 'number');
  const myAvgScore   = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
  const totalEvents  = DATA.events.length;
  const myEvPer100k  = totalEvents > 0 ? +(totalEvents / Math.max(scores.length, 1) * 10).toFixed(1) : 0;

  // Conteo por tipo
  const byType = {};
  DATA.events.forEach(e => { const t=(e.type||'').toLowerCase(); byType[t]=(byType[t]||0)+1; });
  const perDriver = n => scores.length ? +((n/scores.length)*10).toFixed(1) : 0;
  const myFrenadas = perDriver((byType.harsh_braking||0)+(byType.hard_braking||0));
  const myAcels    = perDriver((byType.harsh_acceleration||0)+(byType.hard_acceleration||0));
  const myVel      = perDriver(byType.speeding||0);

  function metricCard(label, myVal, refVal, lowerIsBetter = true) {
    const diff   = myVal - refVal;
    const better = lowerIsBetter ? diff <= 0 : diff >= 0;
    const color  = better ? '#3fb950' : Math.abs(diff) < refVal*0.1 ? '#f97316' : '#f85149';
    const icon   = better ? '✅' : '⚠️';
    const pct    = refVal > 0 ? Math.round(Math.abs(diff)/refVal*100) : 0;
    const txt    = diff === 0 ? t('igual al sector')
      : better
        ? t('{n}% mejor que el sector').replace('{n}', pct)
        : t('{n}% por encima del sector').replace('{n}', pct);
    const barMyW  = Math.min(100, Math.round((myVal  / (Math.max(myVal, refVal)*1.3||1))*100));
    const barRefW = Math.min(100, Math.round((refVal / (Math.max(myVal, refVal)*1.3||1))*100));
    return `
      <div class="bench-card">
        <div class="bench-card-title">${t(label)}</div>
        <div class="bench-bars">
          <div class="bench-bar-row">
            <span class="bench-bar-label">${t('Tu flota')}</span>
            <div class="bench-bar-track"><div class="bench-bar-fill" style="width:${barMyW}%;background:${color}"></div></div>
            <span class="bench-bar-val" style="color:${color}">${myVal}</span>
          </div>
          <div class="bench-bar-row">
            <span class="bench-bar-label">${t('Sector')}</span>
            <div class="bench-bar-track"><div class="bench-bar-fill" style="width:${barRefW}%;background:var(--border-soft)"></div></div>
            <span class="bench-bar-val">${refVal}</span>
          </div>
        </div>
        <div class="bench-verdict">${icon} <span style="color:${color}">${txt}</span></div>
      </div>`;
  }

  grid.innerHTML = `
    <div class="bench-grid">
      ${metricCard('Score promedio', myAvgScore, ref.score, false)}
      ${metricCard('Eventos por conductor', myEvPer100k, ref.eventos_100k)}
      ${metricCard('Frenadas bruscas', myFrenadas, ref.frenadas)}
      ${metricCard('Aceleraciones bruscas', myAcels, ref.aceleraciones)}
      ${metricCard('Excesos de velocidad', myVel, ref.velocidad)}
    </div>
    <p class="bench-note">${t('* Valores de referencia basados en flotas del sector {sector}. Los datos de tu flota son calculados sobre el período cargado.').replace('{sector}', '<strong>' + t(ref.label) + '</strong>')}</p>`;
}

// Inicializar benchmarking cuando haya datos
(function() {
  const _ci2 = setInterval(() => {
    if (DATA && DATA.drivers && DATA.drivers.length > 0 && document.getElementById('benchmarkingGrid')) {
      clearInterval(_ci2);
      renderBenchmarking();
    }
  }, 1000);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 — FEATURE 1: ALERTAS EN TIEMPO REAL
// ═══════════════════════════════════════════════════════════════════════════════

const CRITICAL_TYPES = new Set(['phone_use', 'fatigue', 'seatbelt', 'drowsiness']);
let _alertInterval  = null;
let _lastAlertTs    = null;
let _alertList      = [];
let _alertPanelOpen = false;
let _unreadCount    = 0;

function startRealTimeAlerts() {
  if (_alertInterval) return;
  // Register fleet token for scheduled reports — solo si es hash GPSwox real (no JWT de supervisor)
  if (USER_TOKEN && USER_TOKEN.startsWith('$2y$')) {
    fetch(`${API_BASE}/reports/set-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: USER_TOKEN }),
    }).catch(() => {});
  }
  _alertInterval = setInterval(_checkNewAlerts, 60000);
  _checkNewAlerts(); // immediate first check
}

async function _checkNewAlerts() {
  if (!USER_TOKEN || document.hidden) return;
  try {
    const url = _lastAlertTs
      ? `${API_BASE}/events?token=${encodeURIComponent(USER_TOKEN)}&from=${encodeURIComponent(_lastAlertTs)}`
      : `${API_BASE}/events?token=${encodeURIComponent(USER_TOKEN)}&limit=50`;
    const r    = await fetch(url);
    const data = await r.json();
    const evs  = (data.events || []).filter(e => {
      if (!_lastAlertTs) return false; // skip on first load
      return new Date(e.ts) > new Date(_lastAlertTs);
    });
    if (!_lastAlertTs && data.events?.length) {
      _lastAlertTs = data.events.reduce((max, e) => e.ts > max ? e.ts : max, data.events[0].ts);
      return;
    }
    if (evs.length === 0) return;
    _lastAlertTs = evs.reduce((max, e) => e.ts > max ? e.ts : max, evs[0].ts);

    const newAlerts = evs.map(e => ({
      id:         e.trip_id + '_' + e.ts,
      type:       e.type,
      driver_id:  e.driver_id,
      vehicle_id: e.vehicle_id,
      ts:         e.ts,
      speed:      e.speed,
      critical:   CRITICAL_TYPES.has(e.type),
    }));

    _alertList = [...newAlerts, ..._alertList].slice(0, 100);
    _unreadCount += newAlerts.length;
    _renderAlertBadge();
    _renderAlertList();

    // Sound for critical events
    const hasCritical = newAlerts.some(a => a.critical);
    if (hasCritical) _playAlertSound(true);
    else _playAlertSound(false);

    // Toast for first new alert
    if (newAlerts.length > 0) {
      const a    = newAlerts[0];
      const drv  = DATA?.drivers?.find(d => String(d.id) === String(a.driver_id));
      const name = drv?.name || `Vehículo ${a.vehicle_id}`;
      const label = _alertTypeLabel(a.type);
      _showAlertToast(a.critical ? '🚨' : '⚠️', `${name} — ${label}`, a.critical);
    }
  } catch {}
}

function _alertTypeLabel(type) {
  const map = {
    phone_use:'Uso del teléfono', fatigue:'Fatiga detectada', seatbelt:'Sin cinturón',
    drowsiness:'Somnolencia', overspeed:'Exceso de velocidad', hard_brake:'Frenada brusca',
    hard_acceleration:'Aceleración brusca', hard_cornering:'Curva brusca',
    harsh_braking:'Frenada brusca', harsh_acceleration:'Aceleración brusca',
  };
  return map[type] || type.replace(/_/g, ' ');
}

function _renderAlertBadge() {
  const badge = document.getElementById('alertBadge');
  if (!badge) return;
  if (_unreadCount > 0) {
    badge.textContent = _unreadCount > 99 ? '99+' : _unreadCount;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

function _renderAlertList() {
  const list = document.getElementById('alertList');
  if (!list) return;
  if (_alertList.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted,#9ca3af);font-size:.85rem">Sin alertas recientes</div>';
    return;
  }
  list.innerHTML = _alertList.slice(0, 30).map(a => {
    const drv  = DATA?.drivers?.find(d => String(d.id) === String(a.driver_id));
    const name = drv?.name || `Vehículo ${a.vehicle_id}`;
    const hora = new Date(a.ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const bgCritical = a.critical ? 'rgba(248,81,73,.08)' : 'transparent';
    const dot  = a.critical ? '🔴' : '🟡';
    return `<div style="padding:10px 16px;border-bottom:1px solid var(--border-soft,#f3f4f6);background:${bgCritical}">
      <div style="font-size:.82rem;font-weight:600">${dot} ${_alertTypeLabel(a.type)}</div>
      <div style="font-size:.75rem;color:var(--text-muted,#6b7280);margin-top:2px">${name} · ${hora}</div>
    </div>`;
  }).join('');
}

function toggleAlertPanel() {
  const panel = document.getElementById('alertPanel');
  if (!panel) return;
  _alertPanelOpen = !_alertPanelOpen;
  panel.style.display = _alertPanelOpen ? 'flex' : 'none';
  if (_alertPanelOpen) {
    _unreadCount = 0;
    _renderAlertBadge();
    _renderAlertList();
  }
}

function clearAlerts() {
  _alertList   = [];
  _unreadCount = 0;
  _renderAlertBadge();
  _renderAlertList();
}

function _playAlertSound(critical) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = critical ? 1200 : 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (critical ? 0.6 : 0.3));
    osc.start(); osc.stop(ctx.currentTime + (critical ? 0.6 : 0.3));
    if (critical) {
      setTimeout(() => {
        const o2 = ctx.createOscillator(); const g2 = ctx.createGain();
        o2.connect(g2); g2.connect(ctx.destination);
        o2.frequency.value = 1000;
        g2.gain.setValueAtTime(0.15, ctx.currentTime);
        g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        o2.start(); o2.stop(ctx.currentTime + 0.4);
      }, 700);
    }
  } catch {}
}

function _showAlertToast(ico, msg, critical) {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:80px;right:16px;z-index:2000;background:${critical ? '#f85149' : '#f97316'};color:#fff;padding:10px 16px;border-radius:10px;font-size:.85rem;font-weight:600;max-width:280px;box-shadow:0 4px 20px rgba(0,0,0,.25);animation:slideUp .25s ease`;
  t.textContent = `${ico} ${msg}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// Start alerts when app loads with a token
(function() {
  const _ci3 = setInterval(() => {
    if (USER_TOKEN) { clearInterval(_ci3); startRealTimeAlerts(); }
  }, 2000);
})();

// Close alert panel when clicking outside
document.addEventListener('click', e => {
  if (_alertPanelOpen && !e.target.closest('#alertPanel') && !e.target.closest('#alertBellBtn')) {
    toggleAlertPanel();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 — FEATURE 2: EVENTOS POR 100 KM
// ═══════════════════════════════════════════════════════════════════════════════

let _metricsData = {}; // driver_id → { events_per_100km, total_km, km_source }

async function loadEventsMetrics() {
  if (!USER_TOKEN) return;
  try {
    const r    = await fetch(`${API_BASE}/events/metrics?token=${encodeURIComponent(USER_TOKEN)}`);
    const data = await r.json();
    if (data.status === 'ok') {
      _metricsData = {};
      for (const m of data.metrics) {
        _metricsData[String(m.driver_id)] = m;
      }
    }
  } catch {}
}

function getEventsPerKm(driverId) {
  return _metricsData[String(driverId)] || null;
}

function renderEventsPerKmBadge(driverId) {
  const m = getEventsPerKm(driverId);
  if (!m || m.events_per_100km === null) return '<span style="color:var(--text-muted,#9ca3af);font-size:.75rem">N/D</span>';
  const val   = m.events_per_100km;
  const color = val <= 2 ? '#3fb950' : val <= 5 ? '#f97316' : '#f85149';
  const src   = m.km_source === 'odometer' ? 'odóm.' : 'GPS est.';
  return `<span style="font-weight:700;color:${color};font-size:.85rem">${val}</span><span style="font-size:.65rem;color:var(--text-muted,#9ca3af);margin-left:3px">ev/100km (${src})</span>`;
}

// Load metrics after main data loads
(function() {
  const _ci4 = setInterval(() => {
    if (DATA && DATA.events && DATA.events.length > 0) {
      clearInterval(_ci4);
      loadEventsMetrics();
    }
  }, 3000);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 — FEATURE 3: REPORTES POR EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

let _emailModal = null;

async function openEmailReportModal() {
  const el = document.getElementById('modalEmailReport');
  if (!el) return;
  if (!_emailModal) _emailModal = new bootstrap.Modal(el);
  const body = document.getElementById('emailReportBody');
  body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted,#9ca3af)">Cargando configuración...</div>';
  _emailModal.show();

  try {
    const r   = await fetch(`${API_BASE}/reports/config?token=${encodeURIComponent(USER_TOKEN || '')}`);
    const d   = await r.json();
    const cfg = d.config || {};
    const lastSent = cfg.last_sent ? new Date(cfg.last_sent).toLocaleDateString('es', { dateStyle: 'medium' }) : 'Nunca';

    body.innerHTML = `
      <div style="display:grid;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:.78rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Servidor SMTP</label>
            <input id="cfgSmtpHost" type="text" placeholder="smtp.gmail.com" value="${cfg.smtp_host||''}" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
          </div>
          <div>
            <label style="font-size:.78rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Puerto</label>
            <input id="cfgSmtpPort" type="number" placeholder="587" value="${cfg.smtp_port||587}" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:.78rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Usuario SMTP</label>
            <input id="cfgSmtpUser" type="email" placeholder="tu@correo.com" value="${cfg.smtp_user||''}" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
          </div>
          <div>
            <label style="font-size:.78rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Contraseña SMTP</label>
            <input id="cfgSmtpPass" type="password" placeholder="${cfg.smtp_pass ? '••••••••' : 'Contraseña o app password'}" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
          </div>
        </div>
        <div>
          <label style="font-size:.78rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Destinatario del reporte</label>
          <input id="cfgRecipient" type="email" placeholder="gerente@empresa.com" value="${cfg.recipient||''}" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
        </div>
        <div>
          <label style="font-size:.78rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Envío automático</label>
          <select id="cfgSchedule" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
            <option value="none" ${cfg.schedule==='none'?'selected':''}>Sin programación</option>
            <option value="daily" ${cfg.schedule==='daily'?'selected':''}>Diario</option>
            <option value="weekly" ${cfg.schedule==='weekly'?'selected':''}>Semanal (lunes)</option>
            <option value="monthly" ${cfg.schedule==='monthly'?'selected':''}>Mensual (día 1)</option>
          </select>
        </div>
        <div style="font-size:.75rem;color:var(--text-muted,#9ca3af)">Último envío: ${lastSent}</div>
        <div id="emailCfgError" style="color:#f85149;font-size:.8rem;display:none"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          <button onclick="saveEmailConfig()" style="padding:9px 18px;background:#f97316;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:.85rem">Guardar config</button>
          <button onclick="sendEmailNow()" style="padding:9px 18px;background:none;border:1px solid #f97316;color:#f97316;border-radius:8px;font-weight:600;cursor:pointer;font-size:.85rem" id="btnSendNow">Enviar ahora</button>
        </div>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div style="color:#f85149;padding:16px">Error cargando configuración: ${e.message}</div>`;
  }
}

async function saveEmailConfig() {
  const errEl = document.getElementById('emailCfgError');
  errEl.style.display = 'none';
  const body = {
    smtp_host:  document.getElementById('cfgSmtpHost')?.value?.trim(),
    smtp_port:  parseInt(document.getElementById('cfgSmtpPort')?.value || '587'),
    smtp_user:  document.getElementById('cfgSmtpUser')?.value?.trim(),
    smtp_pass:  document.getElementById('cfgSmtpPass')?.value,
    recipient:  document.getElementById('cfgRecipient')?.value?.trim(),
    schedule:   document.getElementById('cfgSchedule')?.value,
    schedule_day: 1, schedule_hour: 8,
  };
  try {
    const r = await fetch(`${API_BASE}/reports/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    _showAlertToast('✅', 'Configuración guardada', false);
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  }
}

async function sendEmailNow() {
  const btn = document.getElementById('btnSendNow');
  const errEl = document.getElementById('emailCfgError');
  errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
  try {
    const r = await fetch(`${API_BASE}/reports/send-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: USER_TOKEN }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || d.detail);
    _showAlertToast('📧', d.message || 'Reporte enviado', false);
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar ahora'; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 — FEATURE 4: ROLES MULTINIVEL (SUPERVISORES)
// ═══════════════════════════════════════════════════════════════════════════════

let _supervisorToken = localStorage.getItem('driveiq_supervisor_token') || null;
let _supervisorData  = null;
let _supModal        = null;

// If supervisor is logged in, filter data to their vehicles only
async function initSupervisorRole() {
  if (!_supervisorToken) return false;
  try {
    const r = await fetch(`${API_BASE}/supervisors/me`, {
      headers: { Authorization: `Bearer ${_supervisorToken}` },
    });
    if (!r.ok) { localStorage.removeItem('driveiq_supervisor_token'); _supervisorToken = null; return false; }
    const d = await r.json();
    _supervisorData = d.supervisor;
    // Show supervisor banner
    _showSupervisorBanner(_supervisorData.name, _supervisorData.vehicle_ids.length);
    // Show supervisor nav
    const nav = document.getElementById('navSupervisors');
    if (nav) nav.style.display = 'none'; // supervisors don't manage other supervisors
    return true;
  } catch { return false; }
}

async function loadDataAsSupervisor() {
  if (!_supervisorToken) return null;
  try {
    const r = await fetch(`${API_BASE}/supervisor/data`, {
      headers: { Authorization: `Bearer ${_supervisorToken}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function _showSupervisorBanner(name, vehicleCount) {
  const b = document.createElement('div');
  b.id = 'supervisorBanner';
  b.style.cssText = 'background:rgba(249,115,22,.12);border-bottom:2px solid #f97316;padding:8px 20px;font-size:.82rem;display:flex;align-items:center;justify-content:space-between';
  b.innerHTML = `<span>👤 Vista de supervisor: <strong>${name}</strong> · ${vehicleCount} vehículo(s) asignado(s)</span>
    <button onclick="supervisorLogout()" style="background:none;border:1px solid #f97316;color:#f97316;padding:3px 10px;border-radius:6px;font-size:.75rem;cursor:pointer">Salir</button>`;
  document.body.insertBefore(b, document.body.firstChild);
}

function supervisorLogout() {
  localStorage.removeItem('driveiq_supervisor_token');
  _supervisorToken = null; _supervisorData = null;
  document.getElementById('supervisorBanner')?.remove();
  location.reload();
}

// Manager: open supervisor management modal
async function openSupervisorsModal() {
  const el = document.getElementById('modalSupervisors');
  if (!el) return;
  if (!_supModal) _supModal = new bootstrap.Modal(el);
  _supModal.show();
  await _renderSupervisorsModal();
}

async function _renderSupervisorsModal() {
  const body = document.getElementById('supervisorsModalBody');
  if (!body) return;
  body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted,#9ca3af)">Cargando...</div>';

  let sups = [];
  try {
    const r = await fetch(`${API_BASE}/supervisors`);
    const d = await r.json();
    sups = d.supervisors || [];
  } catch {}

  const vehicles = DATA?.vehicles || [];

  const _roleLabel = r => r === 'gerente' ? '👔 Gerente' : r === 'readonly' ? '👁 Solo lectura' : '👤 Supervisor';
  const _roleColor = r => r === 'gerente' ? '#7c3aed' : r === 'readonly' ? '#0ea5e9' : '#f97316';
  const supRows = sups.length ? sups.map(s => {
    const vNames = s.vehicle_ids.map(id => vehicles.find(v => String(v.id || v.vehicle_id) === String(id))?.name || id).join(', ') || 'Todos';
    const role = s.role || 'supervisor';
    return `<tr>
      <td style="padding:8px 12px;font-weight:600">${s.name}</td>
      <td style="padding:8px 12px;color:var(--text-muted,#6b7280);font-size:.82rem">${s.email}</td>
      <td style="padding:8px 12px"><span style="padding:2px 8px;border-radius:6px;font-size:.72rem;font-weight:700;background:rgba(249,115,22,.1);color:${_roleColor(role)}">${_roleLabel(role)}</span></td>
      <td style="padding:8px 12px;font-size:.78rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${vNames}">${vNames}</td>
      <td style="padding:8px 12px"><span style="padding:2px 8px;border-radius:6px;font-size:.72rem;font-weight:700;background:${s.active ? 'rgba(63,185,80,.15)' : 'rgba(110,118,129,.15)'};color:${s.active ? '#3fb950' : '#8b949e'}">${s.active ? 'Activo' : 'Inactivo'}</span></td>
      <td style="padding:8px 12px"><button onclick="deleteSupervisor('${s.id}')" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:.8rem;padding:2px 6px">Eliminar</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-muted,#9ca3af)">Sin supervisores creados</td></tr>`;

  const vehicleOpts = vehicles.slice(0, 200).map(v =>
    `<option value="${v.id || v.vehicle_id}">${v.name || v.plate || v.id}</option>`
  ).join('');

  body.innerHTML = `
    <div style="margin-bottom:20px">
      <h6 style="font-weight:700;margin-bottom:12px">Supervisores existentes</h6>
      <div style="overflow-x:auto;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:.85rem">
          <thead><tr style="border-bottom:1px solid var(--border-soft,#e5e7eb)">
            <th style="padding:8px 12px;text-align:left;color:var(--text-muted,#6b7280);font-size:.72rem;text-transform:uppercase">Nombre</th>
            <th style="padding:8px 12px;text-align:left;color:var(--text-muted,#6b7280);font-size:.72rem;text-transform:uppercase">Email</th>
            <th style="padding:8px 12px;text-align:left;color:var(--text-muted,#6b7280);font-size:.72rem;text-transform:uppercase">Rol</th>
            <th style="padding:8px 12px;text-align:left;color:var(--text-muted,#6b7280);font-size:.72rem;text-transform:uppercase">Vehículos</th>
            <th style="padding:8px 12px;text-align:left;color:var(--text-muted,#6b7280);font-size:.72rem;text-transform:uppercase">Estado</th>
            <th style="padding:8px 12px"></th>
          </tr></thead>
          <tbody>${supRows}</tbody>
        </table>
      </div>
    </div>
    <div style="border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;padding:16px">
      <h6 style="font-weight:700;margin-bottom:12px">Crear nuevo supervisor</h6>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Nombre</label>
          <input id="newSupName" type="text" placeholder="Juan García" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
        </div>
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Email</label>
          <input id="newSupEmail" type="email" placeholder="supervisor@empresa.com" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Contraseña</label>
          <input id="newSupPass" type="password" placeholder="••••••••" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
        </div>
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Vehículos asignados</label>
          <select id="newSupVehicles" multiple style="width:100%;padding:6px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.82rem;max-height:80px">${vehicleOpts}</select>
          <div style="font-size:.68rem;color:var(--text-muted,#9ca3af);margin-top:2px">Ctrl+clic para seleccionar varios. Sin selección = acceso a todos.</div>
        </div>
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Rol</label>
          <select id="newSupRole" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
            <option value="supervisor">👤 Supervisor — ve sus vehículos</option>
            <option value="gerente">👔 Gerente — ve toda la flota</option>
            <option value="readonly">👁 Solo lectura — sin configurar</option>
          </select>
        </div>
      </div>
      <div id="supCreateError" style="color:#f85149;font-size:.8rem;margin-bottom:8px;display:none"></div>
      <button onclick="createSupervisor()" style="padding:9px 20px;background:#f97316;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:.85rem">Crear supervisor</button>
    </div>
    <div style="margin-top:16px;padding:12px 14px;background:rgba(88,166,255,.08);border:1px solid rgba(88,166,255,.2);border-radius:8px;font-size:.78rem;color:var(--text-muted,#6b7280)">
      <strong>Login de supervisor:</strong> Los supervisores ingresan en la misma URL de DriveIQ añadiendo <code>?supervisor=1</code> o desde el enlace que usted les comparta. Usan su email y contraseña.
    </div>`;
}

async function createSupervisor() {
  const errEl = document.getElementById('supCreateError');
  errEl.style.display = 'none';
  const name  = document.getElementById('newSupName')?.value?.trim();
  const email = document.getElementById('newSupEmail')?.value?.trim();
  const pass  = document.getElementById('newSupPass')?.value;
  const role  = document.getElementById('newSupRole')?.value || 'supervisor';
  const selEl = document.getElementById('newSupVehicles');
  const vids  = selEl ? Array.from(selEl.selectedOptions).map(o => o.value) : [];
  if (!name || !email || !pass) { errEl.textContent = 'Nombre, email y contraseña son requeridos'; errEl.style.display = 'block'; return; }
  try {
    const r = await fetch(`${API_BASE}/supervisors/create-v2`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: pass, vehicle_ids: vids, role }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    _showAlertToast('✅', `Supervisor ${name} creado`, false);
    await _renderSupervisorsModal();
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
}

async function deleteSupervisor(id) {
  if (!confirm('¿Eliminar este supervisor?')) return;
  await fetch(`${API_BASE}/supervisors/${id}`, { method: 'DELETE' });
  _showAlertToast('✅', 'Supervisor eliminado', false);
  await _renderSupervisorsModal();
}

// Supervisor login flow — shown when URL has ?supervisor=1
(function() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('supervisor') === '1' && !_supervisorToken) {
    // Show supervisor login overlay
    const overlay = document.createElement('div');
    overlay.id = 'supLoginOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg-body,#f6f8fb);z-index:9999;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--bg-panel,#fff);border:1px solid var(--border-soft,#e5e7eb);border-radius:16px;padding:36px 40px;max-width:380px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.12)">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:2rem">👤</div>
          <div style="font-weight:800;font-size:1.2rem;margin-top:8px">Acceso de Supervisor</div>
          <div style="color:var(--text-muted,#6b7280);font-size:.85rem;margin-top:4px">DriveIQ — Vista limitada</div>
        </div>
        <div style="margin-bottom:12px">
          <label style="font-size:.78rem;font-weight:600;display:block;margin-bottom:4px">Email</label>
          <input id="supLoginEmail" type="email" placeholder="supervisor@empresa.com" style="width:100%;padding:10px 12px;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;background:var(--bg-input,#f9fafb);font-size:.9rem">
        </div>
        <div style="margin-bottom:16px">
          <label style="font-size:.78rem;font-weight:600;display:block;margin-bottom:4px">Contraseña</label>
          <input id="supLoginPass" type="password" placeholder="••••••••" style="width:100%;padding:10px 12px;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;background:var(--bg-input,#f9fafb);font-size:.9rem">
        </div>
        <div id="supLoginErr" style="color:#f85149;font-size:.8rem;margin-bottom:10px;display:none"></div>
        <button id="supLoginBtn" onclick="doSupervisorLogin()" style="width:100%;padding:12px;background:#f97316;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:.95rem;cursor:pointer">Ingresar como Supervisor</button>
      </div>`;
    document.body.appendChild(overlay);
  }
})();

async function doSupervisorLogin() {
  const email = document.getElementById('supLoginEmail')?.value?.trim();
  const pass  = document.getElementById('supLoginPass')?.value;
  const errEl = document.getElementById('supLoginErr');
  const btn   = document.getElementById('supLoginBtn');
  errEl.style.display = 'none';
  if (!email || !pass) { errEl.textContent = 'Email y contraseña requeridos'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'Verificando...';
  try {
    const r = await fetch(`${API_BASE}/supervisors/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    localStorage.setItem('driveiq_supervisor_token', d.token);
    _supervisorToken = d.token;
    _supervisorData  = d.supervisor;
    document.getElementById('supLoginOverlay')?.remove();
    // Now load supervisor data
    const sd = await loadDataAsSupervisor();
    if (sd) {
      DATA = { vehicles: sd.vehicles, drivers: sd.drivers, events: sd.events };
      _showSupervisorBanner(_supervisorData.name, _supervisorData.vehicle_ids.length);
    }
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Ingresar como Supervisor';
  }
}

// Show Supervisors nav link for managers (not supervisors)
(function() {
  const _ci5 = setInterval(() => {
    if (USER_TOKEN && !_supervisorToken) {
      clearInterval(_ci5);
      const nav = document.getElementById('navSupervisors');
      if (nav) nav.style.display = '';
    }
  }, 2000);
})();

// ══════════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS — suscripción VAPID desde el browser
// ══════════════════════════════════════════════════════════════════════════════

let _pushSubscribed = false;

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existingSub = await reg.pushManager.getSubscription();
    if (existingSub) { _pushSubscribed = true; _updatePushBtn(true); return; }
    // No suscripción activa — esperar a que el usuario la active
    _renderPushBellBtn();
  } catch (e) { console.warn('Push init:', e.message); }
}

function _renderPushBellBtn() {
  // Añadir botón de activar push al topbar si no existe
  if (document.getElementById('pushEnableBtn')) return;
  const topbar = document.querySelector('.diq-topbar-actions') || document.querySelector('header') || null;
  if (!topbar) return;
  const btn = document.createElement('button');
  btn.id = 'pushEnableBtn';
  btn.title = 'Activar notificaciones push';
  btn.style.cssText = 'background:none;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;padding:5px 10px;font-size:.78rem;cursor:pointer;color:var(--text-muted,#6b7280);display:flex;align-items:center;gap:4px';
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> Activar push';
  btn.onclick = subscribePush;
  topbar.insertBefore(btn, topbar.firstChild);
}

async function subscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const keyResp = await fetch(`${API_BASE}/push/vapid-key`);
    const { publicKey } = await keyResp.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(publicKey),
    });
    await fetch(`${API_BASE}/push/subscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub }),
    });
    _pushSubscribed = true;
    _updatePushBtn(true);
    _showAlertToast('🔔', 'Notificaciones push activadas', false);
  } catch (e) {
    alert('No se pudo activar push: ' + e.message);
  }
}

function _updatePushBtn(active) {
  const btn = document.getElementById('pushEnableBtn');
  if (!btn) return;
  if (active) {
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> Push activo';
    btn.style.borderColor = '#16a34a';
    btn.style.color = '#16a34a';
    btn.onclick = null;
  }
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// Auto-init push cuando el usuario ya está logueado
(function() {
  const _pi = setInterval(() => {
    if (USER_TOKEN) { clearInterval(_pi); setTimeout(initPushNotifications, 2000); }
  }, 1500);
})();

// ══════════════════════════════════════════════════════════════════════════════
// ROI CALCULATOR — Calculadora de retorno de inversión
// ══════════════════════════════════════════════════════════════════════════════

async function renderROISection() {
  const body = document.getElementById('roiBody');
  if (!body) return;

  // Datos de flota desde API
  let fleetStats = { total_vehicles: 0, total_drivers: 0, hard_events: 0, total_events: 0 };
  try {
    const r = await fetch(`${API_BASE}/roi/fleet-stats`, {
      headers: USER_TOKEN ? { Authorization: `Bearer ${USER_TOKEN}` } : {},
    });
    if (r.ok) fleetStats = await r.json();
  } catch (_) {}

  const vehicles = fleetStats.total_vehicles || (DATA?.vehicles?.length || 5);
  const hardEvts  = fleetStats.hard_events || 0;

  body.innerHTML = `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h6 class="mb-0" style="font-weight:700">Calculadora de ROI del programa</h6>
        <small class="text-muted">Estime el ahorro anual real de su flota con DriveIQ</small>
      </div>
      <span style="font-size:1.4rem">💰</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px">
      <div>
        <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Vehículos en flota</label>
        <input id="roi_vehicles" type="number" min="1" value="${vehicles}" onchange="calcROI()" style="width:100%;padding:9px 12px;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;background:var(--bg-input,#f9fafb);font-size:.9rem">
      </div>
      <div>
        <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Km promedio/vehículo/mes</label>
        <input id="roi_km" type="number" min="1" value="3000" onchange="calcROI()" style="width:100%;padding:9px 12px;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;background:var(--bg-input,#f9fafb);font-size:.9rem">
      </div>
      <div>
        <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Precio combustible (USD/litro)</label>
        <input id="roi_fuel_price" type="number" min="0.1" step="0.01" value="1.10" onchange="calcROI()" style="width:100%;padding:9px 12px;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;background:var(--bg-input,#f9fafb);font-size:.9rem">
      </div>
      <div>
        <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Consumo promedio (km/litro)</label>
        <input id="roi_efficiency" type="number" min="1" step="0.1" value="10" onchange="calcROI()" style="width:100%;padding:9px 12px;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;background:var(--bg-input,#f9fafb);font-size:.9rem">
      </div>
      <div>
        <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Costo mensual DriveIQ (USD)</label>
        <input id="roi_platform_cost" type="number" min="0" step="1" value="0" onchange="calcROI()" style="width:100%;padding:9px 12px;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;background:var(--bg-input,#f9fafb);font-size:.9rem">
      </div>
      <div>
        <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Mejora esperada de score (%)</label>
        <input id="roi_improvement" type="number" min="1" max="100" value="15" onchange="calcROI()" style="width:100%;padding:9px 12px;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;background:var(--bg-input,#f9fafb);font-size:.9rem">
        <div style="font-size:.68rem;color:var(--text-muted,#9ca3af);margin-top:2px">Promedio industria: 10-20%</div>
      </div>
    </div>
    <div id="roiResults" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px"></div>
    <div style="margin-top:14px;padding:12px 14px;background:rgba(249,115,22,.07);border:1px solid rgba(249,115,22,.2);border-radius:8px;font-size:.75rem;color:var(--text-muted,#6b7280)">
      Los cálculos son estimados basados en promedios de la industria de transporte. La mejora real depende de la adopción del programa por parte de los conductores.
    </div>`;

  calcROI();
}

function calcROI() {
  const v       = parseFloat(document.getElementById('roi_vehicles')?.value) || 5;
  const km      = parseFloat(document.getElementById('roi_km')?.value) || 3000;
  const price   = parseFloat(document.getElementById('roi_fuel_price')?.value) || 1.10;
  const eff     = parseFloat(document.getElementById('roi_efficiency')?.value) || 10;
  const cost    = parseFloat(document.getElementById('roi_platform_cost')?.value) || 0;
  const impPct  = parseFloat(document.getElementById('roi_improvement')?.value) || 15;

  // Combustible mensual total (antes)
  const fuelMonthly  = (v * km / eff) * price;
  // Ahorro combustible (freno brusco + aceleración aumenta consumo ~8-12%)
  const fuelSaving   = fuelMonthly * (impPct / 100) * 0.08;
  // Ahorro mantenimiento (frenadas duras ~ $15/evento/mes por desgaste frenos+llantas)
  const maintSaving  = v * (impPct / 100) * 15 * 12 / 12;
  // Reducción de riesgo de accidente (valor asegurador, promedio $800/accidente × tasa reducida)
  const riskSaving   = v * 0.05 * (impPct / 100) * 800 / 12;
  // Total mensual y anual
  const totalMonthly = fuelSaving + maintSaving + riskSaving;
  const totalAnnual  = totalMonthly * 12;
  const netAnnual    = totalAnnual - cost * 12;
  const roi          = cost > 0 ? ((netAnnual / (cost * 12)) * 100) : null;

  const fmt = (n, dec = 0) => n.toLocaleString('es', { minimumFractionDigits: dec, maximumFractionDigits: dec });

  const el = document.getElementById('roiResults');
  if (!el) return;
  el.innerHTML = [
    { label: 'Combustible mensual actual', val: `$${fmt(fuelMonthly, 0)}`, sub: 'USD/mes toda la flota', color: '#6b7280' },
    { label: 'Ahorro combustible/mes', val: `$${fmt(fuelSaving, 0)}`, sub: `${impPct}% mejora conductores`, color: '#f97316' },
    { label: 'Ahorro mantenimiento/mes', val: `$${fmt(maintSaving, 0)}`, sub: 'Frenos y llantas', color: '#f97316' },
    { label: 'Reducción riesgo/mes', val: `$${fmt(riskSaving, 0)}`, sub: 'Valor asegurador estimado', color: '#f97316' },
    { label: 'Ahorro total anual', val: `$${fmt(totalAnnual, 0)}`, sub: 'Antes de costo plataforma', color: '#16a34a' },
    { label: roi !== null ? `ROI del programa` : 'Ahorro neto anual', val: roi !== null ? `${fmt(roi, 0)}%` : `$${fmt(netAnnual, 0)}`, sub: roi !== null ? `Neto anual $${fmt(netAnnual, 0)}` : 'Sin costo de plataforma', color: roi !== null && roi > 0 ? '#16a34a' : '#f97316' },
  ].map(c => `
    <div style="background:var(--bg-panel2,var(--bg-panel,#f9fafb));border:1px solid var(--border-soft,#e5e7eb);border-radius:10px;padding:14px 16px">
      <div style="font-size:.72rem;color:var(--text-muted,#6b7280);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">${c.label}</div>
      <div style="font-size:1.5rem;font-weight:800;color:${c.color}">${c.val}</div>
      <div style="font-size:.72rem;color:var(--text-muted,#9ca3af);margin-top:2px">${c.sub}</div>
    </div>`).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
// RETOS DE DESEMPEÑO — Challenges entre conductores
// ══════════════════════════════════════════════════════════════════════════════

const RETOS_KEY = 'driveiq_retos_v1';

function _loadRetos() {
  try { return JSON.parse(localStorage.getItem(RETOS_KEY) || '[]'); } catch { return []; }
}
function _saveRetos(retos) {
  localStorage.setItem(RETOS_KEY, JSON.stringify(retos));
}

function renderRetosSection() {
  const body = document.getElementById('retosBody');
  if (!body) return;

  const drivers = DATA?.drivers || [];
  const retos   = _loadRetos();

  const driverOpts = drivers.map(d => `<option value="${d.driver_id}">${d.name}</option>`).join('');

  const retosRows = retos.length ? retos.map((r, i) => {
    const d1 = drivers.find(d => String(d.driver_id) === String(r.driver1)) || { name: r.driver1 };
    const d2 = r.driver2 === '__flota__' ? { name: 'Toda la flota' } : (drivers.find(d => String(d.driver_id) === String(r.driver2)) || { name: r.driver2 });
    const score1 = drivers.find(d => String(d.driver_id) === String(r.driver1))?.score ?? 0;
    const score2 = r.driver2 === '__flota__'
      ? (drivers.length ? Math.round(drivers.reduce((a, d) => a + d.score, 0) / drivers.length) : 0)
      : (drivers.find(d => String(d.driver_id) === String(r.driver2))?.score ?? 0);
    const winner = score1 > score2 ? d1.name : score2 > score1 ? d2.name : 'Empate';
    const dayLeft = r.ends ? Math.max(0, Math.ceil((new Date(r.ends) - Date.now()) / 86400000)) : '—';
    const active  = r.ends ? new Date(r.ends) > Date.now() : true;
    return `<tr>
      <td style="padding:8px 12px;font-weight:600">${r.name}</td>
      <td style="padding:8px 12px">${d1.name}</td>
      <td style="padding:8px 12px">${d2.name}</td>
      <td style="padding:8px 12px;text-align:center"><span style="font-weight:700;color:${score1>score2?'#16a34a':score1<score2?'#dc2626':'#6b7280'}">${score1}</span></td>
      <td style="padding:8px 12px;text-align:center"><span style="font-weight:700;color:${score2>score1?'#16a34a':score2<score1?'#dc2626':'#6b7280'}">${score2}</span></td>
      <td style="padding:8px 12px;font-weight:700;color:${active?'#16a34a':'#6b7280'}">${active ? winner : winner + ' ✓'}</td>
      <td style="padding:8px 12px;font-size:.78rem;color:var(--text-muted,#9ca3af)">${active ? (dayLeft + ' días') : 'Finalizado'}</td>
      <td style="padding:8px 12px"><button onclick="_deleteReto(${i})" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:.8rem">Eliminar</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" style="padding:20px;text-align:center;color:var(--text-muted,#9ca3af)">Sin retos activos. Crea el primero abajo.</td></tr>`;

  body.innerHTML = `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h6 class="mb-0" style="font-weight:700">Retos de desempeño</h6>
        <small class="text-muted">Compite entre conductores o contra el promedio de la flota</small>
      </div>
      <span style="font-size:1.4rem">🏁</span>
    </div>
    <div style="overflow-x:auto;border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse;font-size:.84rem">
        <thead><tr style="border-bottom:1px solid var(--border-soft,#e5e7eb)">
          ${['Reto','Conductor 1','Conductor 2 / Rival','Score 1','Score 2','Va ganando','Días restantes',''].map(h=>`<th style="padding:8px 12px;text-align:left;color:var(--text-muted,#6b7280);font-size:.71rem;text-transform:uppercase;white-space:nowrap">${h}</th>`).join('')}
        </tr></thead>
        <tbody>${retosRows}</tbody>
      </table>
    </div>
    <div style="border:1px solid var(--border-soft,#e5e7eb);border-radius:8px;padding:16px">
      <h6 style="font-weight:700;margin-bottom:12px">Crear reto</h6>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:12px">
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Nombre del reto</label>
          <input id="retoName" type="text" placeholder="Semana sin excesos" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
        </div>
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Conductor 1</label>
          <select id="retoDriver1" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem"><option value="">Seleccionar...</option>${driverOpts}</select>
        </div>
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Rival</label>
          <select id="retoDriver2" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
            <option value="__flota__">Promedio de la flota</option>
            ${driverOpts}
          </select>
        </div>
        <div>
          <label style="font-size:.75rem;font-weight:600;color:var(--text-muted,#6b7280);display:block;margin-bottom:4px">Fecha fin</label>
          <input id="retoEnd" type="date" style="width:100%;padding:8px 10px;border:1px solid var(--border-soft,#e5e7eb);border-radius:6px;background:var(--bg-input,#f9fafb);font-size:.85rem">
        </div>
      </div>
      <div id="retoError" style="color:#f85149;font-size:.8rem;margin-bottom:8px;display:none"></div>
      <button onclick="_createReto()" style="padding:9px 20px;background:#f97316;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:.85rem">Crear reto</button>
    </div>`;
}

function _createReto() {
  const name = document.getElementById('retoName')?.value?.trim();
  const d1   = document.getElementById('retoDriver1')?.value;
  const d2   = document.getElementById('retoDriver2')?.value;
  const ends = document.getElementById('retoEnd')?.value;
  const err  = document.getElementById('retoError');
  err.style.display = 'none';
  if (!name || !d1 || !d2) { err.textContent = 'Nombre, conductor 1 y rival son requeridos'; err.style.display = 'block'; return; }
  if (d1 === d2) { err.textContent = 'El conductor 1 y el rival deben ser diferentes'; err.style.display = 'block'; return; }
  const retos = _loadRetos();
  retos.push({ name, driver1: d1, driver2: d2, ends: ends || null, created: new Date().toISOString() });
  _saveRetos(retos);
  _showAlertToast('🏁', `Reto "${name}" creado`, false);
  renderRetosSection();
}

function _deleteReto(index) {
  if (!confirm('¿Eliminar este reto?')) return;
  const retos = _loadRetos();
  retos.splice(index, 1);
  _saveRetos(retos);
  renderRetosSection();
}

// ══════════════════════════════════════════════════════════════════════════════
// SCORE VEHÍCULO vs CONDUCTOR — Análisis cruzado
// ══════════════════════════════════════════════════════════════════════════════

async function renderVehicleVsSection() {
  const body = document.getElementById('vehiculoVsBody');
  if (!body) return;
  body.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted,#9ca3af)">Analizando vehículos y conductores...</div>';

  let data = null;
  try {
    const r = await fetch(`${API_BASE}/analytics/vehicle-vs-driver`, {
      headers: USER_TOKEN ? { Authorization: `Bearer ${USER_TOKEN}` } : {},
    });
    if (r.ok) data = await r.json();
  } catch (_) {}

  const vehicles = data?.vehicles || [];

  if (!vehicles.length) {
    body.innerHTML = `
      <div class="d-flex align-items-center justify-content-between mb-3">
        <div><h6 class="mb-0" style="font-weight:700">Score vehículo vs conductor</h6><small class="text-muted">Identifique si el problema es el operador o la unidad</small></div>
        <span style="font-size:1.4rem">🚗</span>
      </div>
      <div style="padding:30px;text-align:center;color:var(--text-muted,#9ca3af)">
        Sin suficientes datos. Asigne conductores en PilotOS para ver la comparación.
      </div>`;
    return;
  }

  const scoreColor = s => s >= 85 ? '#16a34a' : s >= 70 ? '#f97316' : '#dc2626';
  const scoreLabel = s => s >= 85 ? 'Bueno' : s >= 70 ? 'Regular' : 'Crítico';

  const rows = vehicles.map(v => {
    const conductorBlock = v.conductores.length
      ? v.conductores.slice(0, 3).map(c => `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--border-soft,#e5e7eb)">
            <span style="font-size:.8rem;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.nombre}</span>
            <span style="font-weight:700;font-size:.85rem;color:${scoreColor(c.score)}">${c.score}</span>
            <span style="font-size:.7rem;color:${scoreColor(c.score)};min-width:48px;text-align:right">${scoreLabel(c.score)}</span>
          </div>`).join('')
      : '<div style="color:var(--text-muted,#9ca3af);font-size:.78rem;padding-top:4px">Sin conductor asignado en PilotOS</div>';

    const diagnosis = v.conductores.length
      ? (() => {
          const avgCond = v.conductores.reduce((a, c) => a + c.score, 0) / v.conductores.length;
          const diff = v.vehicle_score - avgCond;
          if (Math.abs(diff) <= 5) return { text: 'Resultado normal', color: '#6b7280' };
          if (diff > 5) return { text: 'Vehículo mejor que conductores — problema de operador', color: '#dc2626' };
          return { text: 'Conductores mejor que el vehículo — revisar estado mecánico', color: '#f97316' };
        })()
      : { text: 'Sin datos de conductor', color: '#9ca3af' };

    return `
      <div style="border:1px solid var(--border-soft,#e5e7eb);border-radius:10px;padding:14px 16px;background:var(--bg-panel2,var(--bg-panel,#f9fafb))">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="width:44px;height:44px;border-radius:50%;background:rgba(249,115,22,.12);display:flex;align-items:center;justify-content:center;font-size:1.1rem">🚗</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.vehicle_name}</div>
            <div style="font-size:.75rem;color:var(--text-muted,#6b7280)">${v.total_events} eventos</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:1.4rem;font-weight:800;color:${scoreColor(v.vehicle_score)}">${v.vehicle_score}</div>
            <div style="font-size:.68rem;color:${scoreColor(v.vehicle_score)}">${scoreLabel(v.vehicle_score)}</div>
          </div>
        </div>
        <div style="font-size:.7rem;font-weight:600;color:var(--text-muted,#6b7280);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Conductores asignados</div>
        ${conductorBlock}
        <div style="margin-top:8px;padding:6px 10px;background:rgba(249,115,22,.06);border-radius:6px;font-size:.73rem;color:${diagnosis.color};font-weight:600">
          ${diagnosis.text}
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div><h6 class="mb-0" style="font-weight:700">Score vehículo vs conductor</h6><small class="text-muted">Identifique si el problema es el operador o la unidad</small></div>
      <span style="font-size:1.4rem">🚗</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">${rows}</div>
    <div style="margin-top:14px;padding:10px 14px;background:rgba(88,166,255,.07);border:1px solid rgba(88,166,255,.2);border-radius:8px;font-size:.75rem;color:var(--text-muted,#6b7280)">
      La asignación conductor-vehículo se lee desde <a href="https://pilotos.gpssoftwarenumberone.com" target="_blank" style="color:#f97316">PilotOS</a>. 
      Asigne conductores a vehículos en PilotOS para ver el diagnóstico comparativo.
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCROLL / SECCIÓN NAV — Extensión para nuevas secciones
// ══════════════════════════════════════════════════════════════════════════════

(function() {
  const _origScrollFinal = window.scrollToSection;
  window.scrollToSection = function(section) {
    const newSections = { roi: 'roiSection', retos: 'retosSection', vehiculovs: 'vehiculoVsSection' };
    if (newSections[section]) {
      const el = document.getElementById(newSections[section]);
      if (el) {
        el.style.display = '';
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        _updateSectionNavActive(section);
        // Render lazy
        if (section === 'roi')        renderROISection();
        if (section === 'retos')      renderRetosSection();
        if (section === 'vehiculovs') renderVehicleVsSection();
        return;
      }
    }
    if (_origScrollFinal) _origScrollFinal(section);
  };
})();
