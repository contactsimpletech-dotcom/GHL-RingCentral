const axios = require('axios');
const config = require('../config');

// Personal email providers to skip when inferring business name from domain
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail','yahoo','hotmail','outlook','icloud','aol','protonmail',
  'live','msn','me','mac','ymail','googlemail','comcast','att',
  'verizon','sbcglobal','bellsouth','cox','charter','earthlink'
]);

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
  const digits = phone.replace(/\D/g, '');
  return `+${digits}`;
}

/**
 * If no business name was extracted but an email was,
 * infer business name from the email domain.
 * e.g. "kevin@costco.com" -> "Costco"
 * Skips personal providers like gmail, yahoo, etc.
 */
function inferBusinessName(info) {
  if (info.businessName || !info.email) return info.businessName || null;
  const domain = info.email.split('@')[1];
  if (!domain) return null;
  const name = domain.split('.')[0].toLowerCase();
  if (PERSONAL_EMAIL_DOMAINS.has(name)) return null;
  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Build a GHL contact payload from extracted caller info.
 */
function buildContactPayload(phone, info = {}) {
  const businessName = inferBusinessName(info) || info.businessName;

  const payload = {
    locationId: config.ghl.locationId,
    phone: normalizePhone(phone),
    firstName: info.firstName || 'Unknown',
    lastName: info.lastName || 'Caller',
  };

  if (info.email)      payload.email       = info.email;
  if (info.jobTitle)   payload.jobTitle    = info.jobTitle;
  if (businessName)    payload.companyName = businessName;
  if (info.website)    payload.website     = info.website;

  const customFields = [];
  if (info.serviceIssue)        customFields.push({ key: 'service_issue',          field_value: info.serviceIssue });
  if (info.networkGroup)        customFields.push({ key: 'network_group',           field_value: info.networkGroup });
  if (info.chapterChamber)      customFields.push({ key: 'chapter_/_chamber',       field_value: info.chapterChamber });
  if (info.networkingEventName) customFields.push({ key: 'networking_event_name',   field_value: info.networkingEventName });
  if (info.industry)            customFields.push({ key: 'industry',                field_value: info.industry });
  if (info.phone)               customFields.push({ key: 'phone',                   field_value: normalizePhone(info.phone) });

  if (customFields.length > 0) payload.customField = customFields;

  return payload;
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
  const payload = buildContactPayload(phone, info);
  console.log('[ghl] Creating contact:', JSON.stringify(payload));
  const res = await client.post('/contacts/', payload);
  const contact = res.data?.contact;
  console.log(`[ghl] Created contact ${contact.id} for ${payload.phone}`);
  return contact;
}

async function updateContact(contactId, info = {}) {
  const client = ghlClient();
  const businessName = inferBusinessName(info) || info.businessName;
  const updates = {};

  if (info.email)    updates.email       = info.email;
  if (info.jobTitle) updates.jobTitle    = info.jobTitle;
  if (businessName)  updates.companyName = businessName;
  if (info.website)  updates.website     = info.website;

  const customFields = [];
  if (info.serviceIssue)        customFields.push({ key: 'service_issue',         field_value: info.serviceIssue });
  if (info.networkGroup)        customFields.push({ key: 'network_group',          field_value: info.networkGroup });
  if (info.chapterChamber)      customFields.push({ key: 'chapter_/_chamber',      field_value: info.chapterChamber });
  if (info.networkingEventName) customFields.push({ key: 'networking_event_name',  field_value: info.networkingEventName });
  if (info.industry)            customFields.push({ key: 'industry',               field_value: info.industry });
  if (info.phone)               customFields.push({ key: 'phone',                  field_value: normalizePhone(info.phone) });

  if (customFields.length > 0) updates.customField = customFields;

  if (Object.keys(updates).length === 0) return;

  try {
    await client.put(`/contacts/${contactId}`, updates);
    console.log(`[ghl] Updated contact ${contactId}:`, JSON.stringify(updates));
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

module.exports = { findContactByPhone, createContact, updateContact, addNote };