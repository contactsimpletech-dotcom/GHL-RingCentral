const axios = require('axios');
const config = require('../config');

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail','yahoo','hotmail','outlook','icloud','aol','protonmail',
  'live','msn','me','mac','ymail','googlemail','comcast','att',
  'verizon','sbcglobal','bellsouth','cox','charter','earthlink'
]);

// Cache of custom field name -> id, loaded once on first use
let _customFieldMap = null;

function ghlClient() {
  return axios.create({
    baseURL: config.ghl.baseUrl,
    headers: {
      Authorization: `Bearer ${config.ghl.apiKey}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
  });
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return `+${digits}`;
}

function inferBusinessName(info) {
  if (info.businessName) return info.businessName;
  if (!info.email) return null;
  const domain = info.email.split('@')[1];
  if (!domain) return null;
  const name = domain.split('.')[0].toLowerCase();
  if (PERSONAL_EMAIL_DOMAINS.has(name)) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Fetch custom fields from GHL and build a name->id map.
 * Normalized: lowercased, spaces/slashes replaced with underscores.
 */
async function getCustomFieldMap() {
  if (_customFieldMap) return _customFieldMap;
  const client = ghlClient();
  try {
    const res = await client.get(`/locations/${config.ghl.locationId}/customFields`);
    const fields = res.data?.customFields || [];
    _customFieldMap = {};
    for (const f of fields) {
      // Store by normalized name and also by original name
      const normalized = f.name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
      _customFieldMap[normalized] = f.id;
      _customFieldMap[f.name.toLowerCase()] = f.id;
      console.log(`[ghl] Custom field: "${f.name}" -> ${f.id}`);
    }
    console.log(`[ghl] Loaded ${fields.length} custom fields`);
  } catch (err) {
    console.error('[ghl] Failed to load custom fields:', err.response?.data || err.message);
    _customFieldMap = {};
  }
  return _customFieldMap;
}

/**
 * Build customField array using real GHL field IDs.
 * Tries multiple name variants to find the right field.
 */
async function buildCustomFields(info) {
  const fieldMap = await getCustomFieldMap();
  const customFields = [];

  const tryAdd = (variants, value) => {
    if (!value) return;
    for (const v of variants) {
      const id = fieldMap[v.toLowerCase()] || fieldMap[v.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_')];
      if (id) {
        customFields.push({ id, field_value: value });
        return;
      }
    }
    console.warn(`[ghl] Could not find field ID for variants: ${variants.join(', ')}`);
  };

  tryAdd(['industry'], info.industry);
  tryAdd(['service issue', 'service_issue'], info.serviceIssue);
  tryAdd(['network group', 'network_group'], info.networkGroup);
  tryAdd(['chapter / chamber', 'chapter_/_chamber', 'chapter chamber', 'chapter_chamber'], info.chapterChamber);
  tryAdd(['networking event name', 'networking_event_name'], info.networkingEventName);
  tryAdd(['main company phone', 'main_company_phone', 'company phone', 'company_phone'], info.phone ? normalizePhone(info.phone) : null);

  return customFields;
}

async function findContactByPhone(phone) {
  const client = ghlClient();
  const normalized = normalizePhone(phone);
  try {
    const res = await client.get('/contacts/', {
      params: { locationId: config.ghl.locationId, query: normalized },
    });
    const contacts = res.data?.contacts || [];
    if (contacts.length > 0) {
      console.log(`[ghl] Found existing contact for ${normalized}: ${contacts[0].id}`);
      return contacts[0];
    }
  } catch (err) {
    console.error('[ghl] Contact search failed:', err.response?.data || err.message);
  }
  return null;
}

async function createContact(phone, info = {}) {
  const client = ghlClient();
  const businessName = inferBusinessName(info);
  const customField = await buildCustomFields(info);

  const payload = {
    locationId: config.ghl.locationId,
    phone: normalizePhone(phone),
    firstName: info.firstName || 'Unknown',
    lastName: info.lastName || 'Caller',
  };

  if (info.email)    payload.email       = info.email;
  if (info.jobTitle) payload.jobTitle    = info.jobTitle;
  if (businessName)  payload.companyName = businessName;
  if (info.website)  payload.website     = info.website;
  if (info.city)     payload.city        = info.city;
  if (info.state)    payload.state       = info.state;
  if (info.postalCode) payload.postalCode = info.postalCode;
  if (info.country)  payload.country     = info.country;
  if (customField.length > 0) payload.customField = customField;

  console.log('[ghl] Creating contact payload:', JSON.stringify(payload));
  const res = await client.post('/contacts/', payload);
  const contact = res.data?.contact;
  console.log(`[ghl] Created contact ${contact.id} for ${payload.phone}`);
  return contact;
}

async function updateContact(contactId, info = {}) {
  const client = ghlClient();
  const businessName = inferBusinessName(info);
  const customField = await buildCustomFields(info);
  const updates = {};

  if (info.email)    updates.email       = info.email;
  if (info.jobTitle) updates.jobTitle    = info.jobTitle;
  if (businessName)  updates.companyName = businessName;
  if (info.website)  updates.website     = info.website;
  if (info.city)     updates.city        = info.city;
  if (info.state)    updates.state       = info.state;
  if (info.postalCode) updates.postalCode = info.postalCode;
  if (info.country)  updates.country     = info.country;
  if (customField.length > 0) updates.customField = customField;

  if (Object.keys(updates).length === 0) return;

  console.log(`[ghl] Updating contact ${contactId}:`, JSON.stringify(updates));
  try {
    await client.put(`/contacts/${contactId}`, updates);
    console.log(`[ghl] Updated contact ${contactId} successfully`);
  } catch (err) {
    console.error(`[ghl] Failed to update contact ${contactId}:`, err.response?.data || err.message);
  }
}

async function addNote(contactId, body) {
  const client = ghlClient();
  const res = await client.post(`/contacts/${contactId}/notes`, { body });
  const note = res.data?.note;
  console.log(`[ghl] Note added to contact ${contactId}: note ID ${note?.id}`);
  return note;
}

module.exports = { findContactByPhone, createContact, updateContact, addNote, getCustomFieldMap };