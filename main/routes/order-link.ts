import { Router } from 'express';
import os from 'os';
import QRCode from 'qrcode';
import { getDatabase, generateOrderNumber, now, getSettingValue } from '../db';

/**
 * 顾客扫码点单（桌台二维码）——无需登录的公开端点。
 * 路径前缀 /api/order-link（已在 requireAuth 放行列表中）。
 */
export const orderLinkRoutes = Router();

// GET /api/order-link/menu?table_id=xx → 桌信息 + 菜单
orderLinkRoutes.get('/menu', (req, res) => {
  try {
    const db = getDatabase();
    const tableId = String(req.query.table_id || '');
    const table = tableId
      ? (db.prepare('SELECT id, number, capacity, status FROM tables WHERE id = ? AND is_active = 1').get(tableId) as any)
      : null;

    const categories = db.prepare(
      'SELECT id, name, sort_order FROM categories WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order, name',
    ).all() as any[];

    const products = db.prepare(
      `SELECT id, name, sku, price, category_id, description, image_url
       FROM products WHERE is_active = 1 AND deleted_at IS NULL
       ORDER BY sort_order, name`,
    ).all() as any[];

    res.json({
      store_name: getSettingValue('business_name') || getSettingValue('store_name') || '门店',
      tableware_product_id: getSettingValue('tableware_product_id') || null,
      tableware_per_persons: Number(getSettingValue('tableware_per_persons')) || 1,
      table,
      categories,
      products,
    });
  } catch (error: any) {
    console.error('[API] order-link menu failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/order-link/orders → 顾客下单（自动加餐具）
orderLinkRoutes.post('/orders', (req, res) => {
  try {
    const db = getDatabase();
    const { table_id, guest_count, items, note } = req.body || {};

    if (!table_id || typeof table_id !== 'string') {
      return res.status(400).json({ error: '缺少桌号' });
    }
    const table = db.prepare('SELECT * FROM tables WHERE id = ? AND is_active = 1').get(table_id) as any;
    if (!table) {
      return res.status(404).json({ error: '桌台不存在' });
    }
    const itemList = Array.isArray(items) ? items : [];
    if (itemList.length === 0) {
      return res.status(400).json({ error: '请先点菜' });
    }
    const count = Math.max(1, Math.min(30, Number(guest_count) || 1));

    const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at LIMIT 1").get() as any;

    const orderNumber = generateOrderNumber();
    const orderResult = db.prepare(`
      INSERT INTO orders (order_number, table_id, user_id, type, guest_count, special_instructions, status, created_at, updated_at)
      VALUES (?, ?, ?, 'dine_in', ?, ?, 'pending', ?, ?)
    `).run(orderNumber, table_id, owner?.id || null, count, note ? String(note).slice(0, 200) : null, now(), now());
    const orderId = Number(orderResult.lastInsertRowid);

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, product_sku, unit_price, quantity, subtotal, total, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);

    let subtotal = 0;
    for (const it of itemList) {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1 AND deleted_at IS NULL').get(it.product_id) as any;
      if (!p) continue;
      const qty = Math.max(1, Math.min(50, Number(it.quantity) || 1));
      const price = Number(p.price) || 0;
      const line = Number((price * qty).toFixed(2));
      insertItem.run(orderId, p.id, p.name, p.sku || '', price, qty, line, line, now(), now());
      subtotal += line;
    }

    // 自动餐具：每 N 人 1 套（设置 tableware_per_persons）
    const tablewareId = getSettingValue('tableware_product_id');
    if (tablewareId) {
      const tw = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1 AND deleted_at IS NULL').get(tablewareId) as any;
      if (tw) {
        const ratio = Math.max(1, Number(getSettingValue('tableware_per_persons')) || 1);
        const qty = Math.max(1, Math.ceil(count / ratio));
        const price = Number(tw.price) || 0;
        const line = Number((price * qty).toFixed(2));
        insertItem.run(orderId, tw.id, tw.name, tw.sku || '', price, qty, line, line, now(), now());
        subtotal += line;
      }
    }

    subtotal = Number(subtotal.toFixed(2));
    db.prepare('UPDATE orders SET subtotal = ?, total = ?, updated_at = ? WHERE id = ?').run(subtotal, subtotal, now(), orderId);

    // 桌台转为占用
    db.prepare("UPDATE tables SET status = 'occupied', updated_at = ? WHERE id = ? AND status = 'available'").run(now(), table_id);

    res.status(201).json({ order_id: orderId, order_number: orderNumber, subtotal, guest_count: count });
  } catch (error: any) {
    console.error('[API] order-link order failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/order-link/qr.svg?table_id=xx → 桌台点单二维码（顾客手机扫码用局域网地址）
orderLinkRoutes.get('/qr.svg', async (req, res) => {
  try {
    const tableId = String(req.query.table_id || '');
    if (!tableId) {
      return res.status(400).json({ error: '缺少桌号' });
    }
    // 优先用门店自定义地址，否则自动探测本机局域网 IPv4 + 当前端口
    const customBase = (getSettingValue('order_link_base_url') || '').trim().replace(/\/$/, '');
    let base = customBase;
    if (!base) {
      const nets = os.networkInterfaces();
      let lanIp = '';
      for (const name of Object.keys(nets)) {
        for (const ni of nets[name] || []) {
          if (ni.family === 'IPv4' && !ni.internal) {
            lanIp = ni.address;
            break;
          }
        }
        if (lanIp) break;
      }
      const port = process.env.PORT || process.env.SERVER_PORT || '3001';
      base = lanIp ? `http://${lanIp}:${port}` : '';
    }
    if (!base) {
      return res.status(500).json({ error: '无法确定门店访问地址，请在设置中配置 order_link_base_url' });
    }
    const url = `${base}/order?table=${encodeURIComponent(tableId)}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 320 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.send(svg);
  } catch (error: any) {
    console.error('[API] order-link qr failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/order-link/qr-url?table_id=xx → 返回二维码指向的 URL（供 UI 展示/复制）
orderLinkRoutes.get('/qr-url', (req, res) => {
  try {
    const tableId = String(req.query.table_id || '');
    if (!tableId) {
      return res.status(400).json({ error: '缺少桌号' });
    }
    const customBase = (getSettingValue('order_link_base_url') || '').trim().replace(/\/$/, '');
    let base = customBase;
    if (!base) {
      const nets = os.networkInterfaces();
      let lanIp = '';
      for (const name of Object.keys(nets)) {
        for (const ni of nets[name] || []) {
          if (ni.family === 'IPv4' && !ni.internal) { lanIp = ni.address; break; }
        }
        if (lanIp) break;
      }
      const port = process.env.PORT || process.env.SERVER_PORT || '3001';
      base = lanIp ? `http://${lanIp}:${port}` : '';
    }
    res.json({ url: `${base}/order?table=${encodeURIComponent(tableId)}`, base });
  } catch (error: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
