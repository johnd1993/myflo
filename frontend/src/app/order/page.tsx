'use client';

import { useEffect, useMemo, useState } from 'react';

type MenuProduct = {
  id: string;
  name: string;
  price: number;
  category_id: string | null;
  description?: string | null;
};
type MenuCategory = { id: string; name: string; sort_order: number };
type MenuData = {
  store_name: string;
  table: { id: string; number: string; capacity: number } | null;
  categories: MenuCategory[];
  products: MenuProduct[];
};

type CartLine = { product: MenuProduct; qty: number };

function fmt(n: number): string {
  return `¥${n.toFixed(2)}`;
}

export default function CustomerOrderPage() {
  const [tableId, setTableId] = useState('');
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [step, setStep] = useState<'guests' | 'menu' | 'done'>('guests');
  const [guestCount, setGuestCount] = useState(4);
  const [activeCat, setActiveCat] = useState<string>('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [doneOrder, setDoneOrder] = useState<{ order_number: string; subtotal: number } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('table') || '';
    setTableId(t);
    if (!t) {
      setLoadError('缺少桌号参数，请扫描桌台上的二维码');
      setLoading(false);
      return;
    }
    fetch(`/api/order-link/menu?table_id=${encodeURIComponent(t)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('加载菜单失败'))))
      .then((data: MenuData) => {
        if (!data.table) {
          setLoadError('桌台不存在或已停用，请联系服务员');
        } else {
          setMenu(data);
          setActiveCat(data.categories[0]?.id || '');
        }
      })
      .catch(() => setLoadError('加载菜单失败，请检查网络后刷新'))
      .finally(() => setLoading(false));
  }, []);

  const cartLines: CartLine[] = useMemo(() => {
    if (!menu) return [];
    return Object.entries(cart)
      .map(([pid, qty]) => {
        const product = menu.products.find((p) => p.id === pid);
        return product ? { product, qty } : null;
      })
      .filter((x): x is CartLine => !!x);
  }, [cart, menu]);

  const cartTotal = cartLines.reduce((s, l) => s + l.product.price * l.qty, 0);
  const cartCount = cartLines.reduce((s, l) => s + l.qty, 0);

  const addToCart = (pid: string, delta: number) => {
    setCart((prev) => {
      const next = { ...prev };
      next[pid] = Math.max(0, (next[pid] || 0) + delta);
      if (next[pid] <= 0) delete next[pid];
      return next;
    });
  };

  const submitOrder = async () => {
    if (cartLines.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch('/api/order-link/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: tableId,
          guest_count: guestCount,
          note,
          items: cartLines.map((l) => ({ product_id: l.product.id, quantity: l.qty })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '下单失败');
      setDoneOrder({ order_number: data.order_number, subtotal: data.subtotal });
      setStep('done');
    } catch (e: any) {
      setSubmitError(e.message || '下单失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-gray-500">菜单加载中…</div>;
  }
  if (loadError || !menu) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-center text-red-500">{loadError || '无法打开点单页'}</div>;
  }

  // ── 第一步：人数 ─────────────────────────────────────────────
  if (step === 'guests') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <header className="bg-white shadow-sm px-5 py-4">
          <h1 className="text-lg font-bold">{menu.store_name}</h1>
          <p className="text-sm text-gray-500">{menu.table?.number} 号桌 · 最多 {menu.table?.capacity} 人</p>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <p className="text-2xl font-semibold mb-2">请问几位用餐？</p>
          <p className="text-sm text-gray-500 mb-8">系统将按人数自动准备餐具</p>
          <div className="flex items-center gap-6 mb-10">
            <button
              className="w-14 h-14 rounded-full bg-white shadow text-2xl font-bold disabled:opacity-30"
              disabled={guestCount <= 1}
              onClick={() => setGuestCount((c) => Math.max(1, c - 1))}
            >−</button>
            <span className="text-5xl font-bold w-20 text-center">{guestCount}</span>
            <button
              className="w-14 h-14 rounded-full bg-orange-500 text-white shadow text-2xl font-bold disabled:opacity-30"
              disabled={guestCount >= 30}
              onClick={() => setGuestCount((c) => Math.min(30, c + 1))}
            >+</button>
          </div>
          <button
            className="w-full max-w-xs py-4 rounded-xl bg-orange-500 text-white text-lg font-bold shadow"
            onClick={() => setStep('menu')}
          >开始点菜</button>
        </div>
      </div>
    );
  }

  // ── 第三步：完成 ─────────────────────────────────────────────
  if (step === 'done' && doneOrder) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-6 text-center">
        <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mb-6">
          <span className="text-4xl text-green-600">✓</span>
        </div>
        <h1 className="text-2xl font-bold mb-2">下单成功</h1>
        <p className="text-gray-500 mb-1">{menu.table?.number} 号桌 · {guestCount} 人</p>
        <p className="text-gray-500 mb-6">单号 {doneOrder.order_number} · 暂估 {fmt(doneOrder.subtotal)}</p>
        <p className="text-sm text-gray-400 mb-10">厨房已收到订单，请稍候上菜</p>
        <button
          className="w-full max-w-xs py-3 rounded-xl border border-gray-300 text-gray-600"
          onClick={() => { setStep('menu'); setCart({}); setNote(''); }}
        >继续加菜</button>
      </div>
    );
  }

  // ── 第二步：点菜 ─────────────────────────────────────────────
  const visibleProducts = activeCat
    ? menu.products.filter((p) => p.category_id === activeCat)
    : menu.products;

  return (
    <div className="min-h-screen bg-gray-50 pb-28">
      <header className="bg-white shadow-sm px-5 py-3 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <h1 className="font-bold">{menu.store_name}</h1>
          <span className="text-sm text-gray-500">{menu.table?.number}号桌 · {guestCount}人</span>
        </div>
      </header>

      {/* 分类 */}
      <div className="flex gap-2 overflow-x-auto px-4 py-3 bg-white">
        {menu.categories.map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveCat(c.id)}
            className={`shrink-0 px-4 py-1.5 rounded-full text-sm ${activeCat === c.id ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
          >{c.name}</button>
        ))}
      </div>

      {/* 商品列表 */}
      <div className="px-4 py-3 space-y-3">
        {visibleProducts.length === 0 && <p className="text-center text-gray-400 py-10">该分类暂无菜品</p>}
        {visibleProducts.map((p) => (
          <div key={p.id} className="bg-white rounded-xl p-3 flex items-center gap-3 shadow-sm">
            <div className="flex-1">
              <p className="font-medium">{p.name}</p>
              {p.description && <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{p.description}</p>}
              <p className="text-orange-600 font-bold mt-1">{fmt(p.price)}</p>
            </div>
            <div className="flex items-center gap-2">
              {(cart[p.id] || 0) > 0 && (
                <>
                  <button className="w-8 h-8 rounded-full bg-gray-100 font-bold" onClick={() => addToCart(p.id, -1)}>−</button>
                  <span className="w-6 text-center font-bold">{cart[p.id]}</span>
                </>
              )}
              <button className="w-8 h-8 rounded-full bg-orange-500 text-white font-bold" onClick={() => addToCart(p.id, 1)}>+</button>
            </div>
          </div>
        ))}
      </div>

      {/* 底部购物车 */}
      {cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-[0_-4px_16px_rgba(0,0,0,0.08)] px-4 py-3 z-20">
          <div className="max-w-2xl mx-auto flex items-center gap-3">
            <div className="flex-1">
              <p className="font-bold">{cartCount} 件 · {fmt(cartTotal)}</p>
              <p className="text-xs text-gray-400">餐具将按 {guestCount} 人自动配</p>
            </div>
            <button
              className="px-6 py-3 rounded-xl bg-orange-500 text-white font-bold disabled:opacity-50"
              disabled={submitting}
              onClick={() => void submitOrder()}
            >{submitting ? '提交中…' : '去下单'}</button>
          </div>
          {submitError && <p className="text-center text-red-500 text-sm mt-1">{submitError}</p>}
        </div>
      )}
    </div>
  );
}
