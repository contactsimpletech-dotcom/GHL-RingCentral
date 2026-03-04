const axios = require('axios');
const config = require('../config');

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
  const digits = phone.replace(/\D/g, '');
  return `+${digits}`;
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

/**
 * Create a new GHL contact.
 * Maps extracted email to the email field and phone to companyPhone field.
 */
async function createContact(phone, firstName, lastName, email = null, extractedPhone = null) {
  const client = ghlClient();
  const normalized = normalizePhone(phone);

  const payload = {
    locationId: config.ghl.locationId,
    phone: normalized,
    firstName: firstName || 'Unknown',
    lastName: lastName || 'Caller',
  };

  // Map email to GHL email field
  if (email) {
    payload.email = email;
    console.log(`[ghl] Setting email: ${email}`);
  }

  // Map spoken phone number to companyPhone field (Main Company Phone in GHL)
  if (extractedPhone) {
    const normalizedExtracted = normalizePhone(extractedPhone);
    payload.companyPhone = normalizedExtracted;
    console.log(`[ghl] Setting companyPhone: ${normalizedExtracted}`);
  }

  const res = await client.post('/contacts/', payload);
  const contact = res.data?.contact;
  console.log(`[ghl] Created contact ${contact.id} (${firstName} ${lastName}) for ${normalized}`);
  return contact;
}

/**
 * Update an existing GHL contact with email and/or phone from transcript.
 */
async function updateContact(contactId, { email, phone } = {}) {
  const client = ghlClient();
  const updates = {};

  if (email) updates.email = email;
  if (phone) updates.companyPhone = normalizePhone(phone);

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