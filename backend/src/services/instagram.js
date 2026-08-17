// Instagram Messaging API — "Business Login for Instagram" akışı kullanılıyor
// (teknonandcom hesabı doğrudan giriş yaparak yetki verdi). Bu akışta tüm API
// çağrıları graph.facebook.com değil, graph.instagram.com üzerinden yapılır.
async function sendInstagramMessage(igsid, text) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  if (!accessToken || !igUserId) {
    return { ok: false, error: 'Instagram API yapılandırılmamış' };
  }

  try {
    const res = await fetch(`https://graph.instagram.com/v21.0/${igUserId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: igsid },
        message: { text },
      }),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    return { ok: true, igMessageId: json.message_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendInstagramMessage };
