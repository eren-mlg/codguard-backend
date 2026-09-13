const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// === AYARLAR ===
const SHOPIFY_DOMAIN = 'codguard-test-store.myshopify.com';
const SHOPIFY_TOKEN = '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';
const TELEGRAM_BOT_TOKEN = '8795623230:AAGbVx6PLV8fssu5X42PdITJ1uII6wBkD1M';
const TELEGRAM_CHAT_ID = '6896201538';

// Aktif Pinggy Linkin
const BASE_URL = 'https://drqot-31-223-56-202.run.pinggy-free.link';

// Siparişleri ve sayaçları tutan veritabanı
const ordersDb = {};
let savedShippingCost = 0;
const SHIPPING_COST_PER_RETURN = 150;

app.use(express.json());

// 1. Shopify Siparişine Etiket Basma
async function updateShopifyOrderTag(orderId, tag) {
    const url = 'https://' + SHOPIFY_DOMAIN + '/admin/api/2024-07/orders/' + orderId + '.json';
    try {
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_TOKEN
            },
            body: JSON.stringify({
                order: { id: orderId, tags: tag }
            })
        });

        if (response.ok) {
            console.log('[SHOPIFY GUNCEL]: #' + orderId + ' siparis etiketlendi -> ' + tag);
        } else {
            const errData = await response.text();
            console.log('[SHOPIFY YANITI] HTTP ' + response.status + ' : ' + errData);
        }
    } catch (error) {
        console.error('[SHOPIFY BAGLANTI HATASI]:', error.message);
    }
}

// 2. Telegram Bildirimi
async function sendTelegramNotification(customerName, orderId, totalPrice, confirmUrl, cancelUrl) {
    const telegramUrl = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';

    const messageText = 
        '🔔 *YENI KAPIDA ODEME SIPARISI!*\n\n' +
        '👤 *Musteri:* ' + customerName + '\n' +
        '📦 *Siparis No:* #' + orderId + '\n' +
        '💰 *Tutar:* ' + totalPrice + '\n\n' +
        'Musteri onay durumuna gore islem secin:';

    const payload = {
        chat_id: TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Siparisi Onayla', url: confirmUrl },
                    { text: '❌ Iptal Et (Kargo Kurtar)', url: cancelUrl }
                ]
            ]
        }
    };

    try {
        const res = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            console.log('[TELEGRAM]: Bildirim basariyla iletildi.');
        } else {
            const err = await res.text();
            console.log('[TELEGRAM HATA]:', err);
        }
    } catch (err) {
        console.error('[TELEGRAM BAGLANTI HATASI]:', err.message);
    }
}

// 3. Webhook Dinleyicisi
app.post('/api/order-webhook', async (req, res) => {
    const order = req.body;
    
    const verifyToken = crypto.randomBytes(8).toString('hex');
    const orderId = order.id ? String(order.id) : String(order.order_number || '1234');
    const customerName = (order.customer?.first_name || 'Musteri') + ' ' + (order.customer?.last_name || '');
    const totalPrice = (order.total_price || '0.00') + ' ' + (order.currency || 'TL');

    ordersDb[verifyToken] = {
        orderId: orderId,
        customer: customerName.trim(),
        total: totalPrice,
        status: 'ONAY_BEKLIYOR',
        date: new Date().toLocaleTimeString('tr-TR')
    };

    const confirmLink = BASE_URL + '/order/' + verifyToken + '/confirm';
    const cancelLink = BASE_URL + '/order/' + verifyToken + '/cancel';

    console.log('\n================ YENI SIPARIS GELDI ================');
    console.log('Siparis No : #' + orderId);
    console.log('Musteri    : ' + ordersDb[verifyToken].customer);
    console.log('Telegram bildirimi gonderiliyor...');
    console.log('=====================================================\n');

    await sendTelegramNotification(
        ordersDb[verifyToken].customer,
        orderId,
        totalPrice,
        confirmLink,
        cancelLink
    );

    res.status(200).send('Webhook Alindi');
});

// 4. Onay Linki
app.get('/order/:token/confirm', async (req, res) => {
    const token = req.params.token;
    const order = ordersDb[token];

    if (!order) return res.status(404).send('Gecersiz link.');

    order.status = 'ONAYLANDI';
    console.log('\n>>> [MUSTERI ONAYLADI] #' + order.orderId + ' kargo hazirlanabilir! <<<');

    await updateShopifyOrderTag(order.orderId, 'COD-Onaylandi');
    res.send('Siparis basariyla ONAYLANDI. Kargo hazirlaniyor.');
});

// 5. İptal Linki (Zarar Kurtarma Sayacı Artar)
app.get('/order/:token/cancel', async (req, res) => {
    const token = req.params.token;
    const order = ordersDb[token];

    if (!order) return res.status(404).send('Gecersiz link.');

    if (order.status !== 'IPTAL_EDILDI') {
        savedShippingCost += SHIPPING_COST_PER_RETURN;
    }
    order.status = 'IPTAL_EDILDI';
    console.log('\n>>> [MUSTERI IPTAL ETTI] #' + order.orderId + ' Kargo zarari engellendi! <<<');

    await updateShopifyOrderTag(order.orderId, 'COD-Iptal');
    res.send('Siparis IPTAL edildi. Magazanin bosuna kargo odemesi engellendi.');
});

// 6. SaaS Canlı Dashboard Paneli
app.get('/dashboard', (req, res) => {
    const keys = Object.keys(ordersDb);
    const totalOrders = keys.length;
    const confirmedCount = keys.filter(k => ordersDb[k].status === 'ONAYLANDI').length;
    const canceledCount = keys.filter(k => ordersDb[k].status === 'IPTAL_EDILDI').length;

    let rowsHtml = '';
    const reversedKeys = [...keys].reverse();

    if (reversedKeys.length === 0) {
        rowsHtml = '\x3ctr\x3e\x3ctd colspan="5" style="padding:24px;text-align:center;color:#94a3b8;"\x3eHenuz siparis gelmedi.\x3c/td\x3e\x3c/tr\x3e';
    } else {
        reversedKeys.forEach(token => {
            const item = ordersDb[token];
            let badgeBg = '#eab308';
            if (item.status === 'ONAYLANDI') badgeBg = '#22c55e';
            if (item.status === 'IPTAL_EDILDI') badgeBg = '#ef4444';

            rowsHtml += '\x3ctr\x3e' +
                '\x3ctd style="padding:12px;border-bottom:1px solid #334155;"\x3e' + item.date + '\x3c/td\x3e' +
                '\x3ctd style="padding:12px;border-bottom:1px solid #334155;font-weight:bold;"\x3e#' + item.orderId + '\x3c/td\x3e' +
                '\x3ctd style="padding:12px;border-bottom:1px solid #334155;"\x3e' + item.customer + '\x3c/td\x3e' +
                '\x3ctd style="padding:12px;border-bottom:1px solid #334155;"\x3e' + item.total + '\x3c/td\x3e' +
                '\x3ctd style="padding:12px;border-bottom:1px solid #334155;"\x3e\x3cspan style="background:' + badgeBg + ';color:#fff;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:bold;"\x3e' + item.status + '\x3c/span\x3e\x3c/td\x3e' +
                '\x3c/tr\x3e';
        });
    }

    const html = '\x3c!DOCTYPE html\x3e\x3chtml\x3e\x3chead\x3e\x3cmeta charset="utf-8"\x3e\x3ctitle\x3eCodGuard SaaS Paneli\x3c/title\x3e' +
        '\x3cmeta http-equiv="refresh" content="5"\x3e' +
        '\x3cstyle\x3ebody{font-family:sans-serif;background:#0f172a;color:#f8fafc;margin:0;padding:32px;}' +
        '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:32px;}' +
        '.card{background:#1e293b;padding:20px;border-radius:12px;border:1px solid #334155;}' +
        '.card h3{margin:0;color:#94a3b8;font-size:13px;text-transform:uppercase;}' +
        '.card .val{font-size:28px;font-weight:bold;margin-top:10px;}' +
        'table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155;}' +
        'th{background:#334155;color:#cbd5e1;padding:12px;text-align:left;font-size:13px;}' +
        '\x3c/style\x3e\x3c/head\x3e\x3cbody\x3e' +
        '\x3ch2\x3e🛡️ CodGuard Operasyon Paneli\x3c/h2\x3e' +
        '\x3cp style="color:#94a3b8;margin-bottom:24px;"\x3eCanli Kapida Odeme Dogrulama ve Zarar Onleme Motoru (5 sn otomatik yenilenir)\x3c/p\x3e' +
        '\x3cdiv class="grid"\x3e' +
        '\x3cdiv class="card"\x3e\x3ch3\x3eKurtarilan Kargo Maliyeti\x3c/h3\x3e\x3cdiv class="val" style="color:#22c55e;"\x3e' + savedShippingCost + ' TL\x3c/div\x3e\x3c/div\x3e' +
        '\x3cdiv class="card"\x3e\x3ch3\x3eOnaylanan Siparis\x3c/h3\x3e\x3cdiv class="val" style="color:#38bdf8;"\x3e' + confirmedCount + ' Adet\x3c/div\x3e\x3c/div\x3e' +
        '\x3cdiv class="card"\x3e\x3ch3\x3eEngellenen Iadeler\x3c/h3\x3e\x3cdiv class="val" style="color:#ef4444;"\x3e' + canceledCount + ' Adet\x3c/div\x3e\x3c/div\x3e' +
        '\x3cdiv class="card"\x3e\x3ch3\x3eToplam Islem\x3c/h3\x3e\x3cdiv class="val"\x3e' + totalOrders + '\x3c/div\x3e\x3c/div\x3e' +
        '\x3c/div\x3e' +
        '\x3ch3 style="margin-bottom:16px;"\x3eGelen Siparis Akisi\x3c/h3\x3e' +
        '\x3ctable\x3e\x3cthead\x3e\x3ctr\x3e\x3cth\x3eSaat\x3c/th\x3e\x3cth\x3eSiparis No\x3c/th\x3e\x3cth\x3eMusteri\x3c/th\x3e\x3cth\x3eTutar\x3c/th\x3e\x3cth\x3eDurum\x3c/th\x3e\x3c/tr\x3e\x3c/thead\x3e' +
        '\x3ctbody\x3e' + rowsHtml + '\x3c/tbody\x3e\x3c/table\x3e' +
        '\x3c/body\x3e\x3c/html\x3e';

    res.send(html);
});

app.listen(PORT, () => {
    console.log('CodGuard sistemi http://localhost:' + PORT + ' uzerinde hazir!');
    console.log('SaaS Dashboard Adresi: http://localhost:3000/dashboard');
});