// Vercel Serverless Function: приём заявок с сайта Vela.
// Отправляет лид в amoCRM (контакт + сделка) и уведомление в Telegram.
// Переменные окружения (Vercel → Settings → Environment Variables):
//   AMO_DOMAIN       — поддомен amoCRM, например: velaclinic.amocrm.ru
//   AMO_TOKEN        — долгосрочный токен API amoCRM (amoCRM → Настройки → Интеграции → Внешняя интеграция → Долгосрочный токен)
//   AMO_PIPELINE_ID  — (необязательно) ID воронки, куда класть сделки
//   TG_TOKEN, TG_CHAT — (необязательно) бот и чат для уведомлений о заявках
// Если ни amoCRM, ни Telegram не настроены, функция отвечает ok:false и сайт
// автоматически уводит заявку в WhatsApp (фоллбэк).

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  const name = String(body.name || '').trim().slice(0, 100);
  const phone = String(body.phone || '').trim().slice(0, 30);
  const service = String(body.service || '').trim().slice(0, 120);
  const page = String(body.page || '').slice(0, 300);
  const utm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid']
    .filter(k => body[k]).map(k => `${k}=${String(body[k]).slice(0, 100)}`).join(' ');

  if (phone.replace(/\D/g, '').length < 10) return res.status(400).json({ ok: false, error: 'phone' });

  const result = { ok: false, amo: null, tg: null };

  // ---------- amoCRM ----------
  const { AMO_DOMAIN, AMO_TOKEN, AMO_PIPELINE_ID } = process.env;
  if (AMO_DOMAIN && AMO_TOKEN) {
    try {
      const lead = {
        name: 'Заявка с сайта' + (service ? ': ' + service : ''),
        _embedded: {
          tags: [{ name: 'сайт' }],
          contacts: [{
            first_name: name || 'Пациентка',
            custom_fields_values: [
              { field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] }
            ]
          }]
        }
      };
      if (AMO_PIPELINE_ID) lead.pipeline_id = Number(AMO_PIPELINE_ID);
      const r = await fetch(`https://${AMO_DOMAIN}/api/v4/leads/complex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AMO_TOKEN}` },
        body: JSON.stringify([lead])
      });
      result.amo = r.ok;
      if (r.ok) {
        // добавим примечание со страницей и UTM к сделке
        try {
          const created = await r.json();
          const leadId = created && created[0] && created[0].id;
          if (leadId && (page || utm)) {
            await fetch(`https://${AMO_DOMAIN}/api/v4/leads/${leadId}/notes`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AMO_TOKEN}` },
              body: JSON.stringify([{ note_type: 'common', params: { text: `Источник: сайт Vela\nСтраница: ${page}\n${utm}`.trim() } }])
            });
          }
        } catch (e) { /* примечание необязательно */ }
      } else {
        result.amoError = r.status;
      }
    } catch (e) {
      result.amo = false;
      result.amoError = String(e && e.message || e).slice(0, 200);
    }
  }

  // ---------- Telegram ----------
  const { TG_TOKEN, TG_CHAT } = process.env;
  if (TG_TOKEN && TG_CHAT) {
    try {
      const text = [
        '🟢 Новая заявка с сайта Vela',
        `👤 Имя: ${name || '—'}`,
        `📞 Телефон: ${phone}`,
        service ? `💬 Запрос: ${service}` : '',
        utm ? `🏷 ${utm}` : '',
        page ? `🔗 ${page}` : '',
        result.amo === true ? '✅ Сделка создана в amoCRM' : (result.amo === false ? '⚠️ amoCRM: ошибка, проверьте настройки' : '')
      ].filter(Boolean).join('\n');
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
      });
      result.tg = r.ok;
    } catch (e) { result.tg = false; }
  }

  result.ok = result.amo === true || result.tg === true;
  return res.status(200).json(result);
};
