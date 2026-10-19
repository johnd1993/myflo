'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Upload,
  ArrowUp,
  ArrowDown,
  Save,
  CheckCircle2,
  Archive,
  RotateCcw,
  Download,
  Pencil,
  ChevronLeft,
  Loader2,
  FileText,
  ShieldAlert,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Toggle } from '@/components/settings/Toggle';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';

// ---------------------------------------------------------------------------
// Merchant template contract (mirrors shared/print/merchant-template.ts)
// ---------------------------------------------------------------------------

const BLOCK_KINDS = [
  'business-header',
  'customer',
  'document-meta',
  'item-table',
  'totals',
  'tax-breakdown',
  'payments',
  'message',
] as const;

const BLOCK_LABEL_FIELDS: Record<string, string[]> = {
  'business-header': [],
  'document-meta': ['title', 'invoiceNumber'],
  customer: [],
  'item-table': ['item', 'quantity', 'amount', 'note'],
  'tax-breakdown': [],
  totals: [
    'subtotal',
    'discount',
    'tax',
    'grandTotal',
    'pointsRedeemed',
    'pointsEarned',
    'pointsBalance',
  ],
  payments: [],
  message: ['reprintBanner', 'onlineOrderBanner', 'thankYou'],
};

const TEMPLATE_FORMAT = 'flocafe-merchant-print-template';

/** i18n keys for block kind names (flat message keys for type-safe t()). */
const BLOCK_KIND_KEYS = {
  'business-header': 'blockKindBusinessHeader',
  customer: 'blockKindCustomer',
  'document-meta': 'blockKindDocumentMeta',
  'item-table': 'blockKindItemTable',
  message: 'blockKindMessage',
  payments: 'blockKindPayments',
  'tax-breakdown': 'blockKindTaxBreakdown',
  totals: 'blockKindTotals',
} as const;

/** i18n keys for semantic label fields (flat message keys). */
const LABEL_FIELD_KEYS = {
  title: 'labelFieldTitle',
  invoiceNumber: 'labelFieldInvoiceNumber',
  item: 'labelFieldItem',
  quantity: 'labelFieldQuantity',
  amount: 'labelFieldAmount',
  note: 'labelFieldNote',
  subtotal: 'labelFieldSubtotal',
  discount: 'labelFieldDiscount',
  tax: 'labelFieldTax',
  grandTotal: 'labelFieldGrandTotal',
  pointsRedeemed: 'labelFieldPointsRedeemed',
  pointsEarned: 'labelFieldPointsEarned',
  pointsBalance: 'labelFieldPointsBalance',
  reprintBanner: 'labelFieldReprintBanner',
  onlineOrderBanner: 'labelFieldOnlineOrderBanner',
  thankYou: 'labelFieldThankYou',
} as const;

interface MerchantBlockSpec {
  kind: string;
  visible?: boolean;
  labels?: Record<string, string>;
}

interface TemplatePayload {
  format: string;
  documentType: string;
  schemaVersion: number;
  blocks: MerchantBlockSpec[];
}

interface TemplateRow {
  id: string;
  name: string;
  origin: 'created' | 'imported' | 'cloned';
  documentType: string;
  schemaVersion: number;
  status: 'draft' | 'active' | 'archived';
  hasPreviousPayload: boolean;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

function defaultPayload(): TemplatePayload {
  return {
    format: TEMPLATE_FORMAT,
    documentType: 'receipt',
    schemaVersion: 1,
    blocks: [
      { kind: 'business-header' },
      { kind: 'document-meta' },
      { kind: 'customer' },
      { kind: 'item-table' },
      { kind: 'tax-breakdown', visible: false },
      { kind: 'totals' },
      { kind: 'payments' },
      { kind: 'message' },
    ],
  };
}

/** Strip empty labels so stored payloads stay canonical. */
function cleanPayload(payload: TemplatePayload): TemplatePayload {
  return {
    format: payload.format,
    documentType: payload.documentType,
    schemaVersion: payload.schemaVersion,
    blocks: payload.blocks.map((block) => {
      const next: MerchantBlockSpec = { kind: block.kind };
      if (block.visible === false) next.visible = false;
      const labels = block.labels
        ? Object.fromEntries(
            Object.entries(block.labels).filter(([, value]) => value !== undefined && value !== ''),
          )
        : {};
      if (Object.keys(labels).length > 0) next.labels = labels;
      return next;
    }),
  };
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

/** Sample data used to render the editor's live preview (receipt, 80mm look). */
const PREVIEW_DATA = {
  businessName: '黄记砂锅炒菜',
  docTitle: '小票',
  orderNumber: 'ORD-1001',
  customerName: '张敏',
  items: [
    { name: '饺子', quantity: 2, amount: 24 },
    { name: '宫保鸡丁', quantity: 1, amount: 38 },
  ],
  subtotal: 62,
  discount: 0,
  tax: 0,
  grandTotal: 62,
  payment: '现金',
  paidAmount: 62,
};

function previewLabel(labels: Record<string, string> | undefined, field: string, fallback: string): string {
  const value = labels?.[field];
  return value && value.trim() !== '' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PrintTemplatesTab() {
  const t = useTranslations('settings');
  const { currentTenant } = useAuthStore();
  const canView = tenantCan(currentTenant, 'print-templates.view');
  const canManage = tenantCan(currentTenant, 'print-templates.manage');

  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  // Editor state: null = list view; { id } = edit existing; { id: null } = new draft
  const [editing, setEditing] = useState<{ id: string | null; name: string; payload: TemplatePayload } | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftPayload, setDraftPayload] = useState<TemplatePayload | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await api.get('/print-templates');
      setTemplates(res.data?.templates ?? []);
    } catch {
      toast.error(t('templateListLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (canView) void loadTemplates();
    else setLoading(false);
  }, [canView, loadTemplates]);

  const openNew = () => {
    const payload = defaultPayload();
    setDraftName(t('templateNewName'));
    setDraftPayload(payload);
    setEditing({ id: null, name: t('templateNewName'), payload });
  };

  const openEdit = async (template: TemplateRow) => {
    setActingId(template.id);
    try {
      const res = await api.get(`/print-templates/${template.id}/payload`);
      const payload = res.data?.payload as TemplatePayload;
      setDraftName(template.name);
      setDraftPayload(payload);
      setEditing({ id: template.id, name: template.name, payload });
    } catch {
      toast.error(t('templateLoadFailed'));
    } finally {
      setActingId(null);
    }
  };

  const closeEditor = () => {
    setEditing(null);
    setDraftName('');
    setDraftPayload(null);
    void loadTemplates();
  };

  const persist = async (activateAfterSave: boolean) => {
    if (!editing || !draftPayload) return;
    const payload = cleanPayload(draftPayload);
    setSaving(true);
    try {
      if (editing.id === null) {
        const res = await api.post('/print-templates', { name: draftName, payload });
        const created = res.data?.template as TemplateRow;
        if (activateAfterSave) {
          await api.post(`/print-templates/${created.id}/activate`);
          toast.success(t('templateCreatedAndActivated'));
        } else {
          toast.success(t('templateCreated'));
        }
        closeEditor();
      } else {
        await api.put(`/print-templates/${editing.id}`, { name: draftName, payload });
        if (activateAfterSave) {
          await api.post(`/print-templates/${editing.id}/activate`);
          toast.success(t('templateSavedAndActivated'));
        } else {
          toast.success(t('templateSaved'));
        }
        closeEditor();
      }
    } catch {
      toast.error(t('templateSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (id: string, action: 'activate' | 'archive' | 'rollback') => {
    setActingId(id);
    try {
      await api.post(`/print-templates/${id}/${action}`);
      toast.success(
        action === 'activate'
          ? t('templateActivated')
          : action === 'archive'
            ? t('templateArchived')
            : t('templateRolledBack'),
      );
      await loadTemplates();
    } catch {
      toast.error(t('templateActionFailed'));
    } finally {
      setActingId(null);
    }
  };

  const exportTemplate = async (template: TemplateRow) => {
    setActingId(template.id);
    try {
      const res = await api.get(`/print-templates/${template.id}/export`, { responseType: 'blob' });
      const blob = new Blob([res.data], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      const disposition = String(res.headers?.['content-disposition'] ?? '');
      const match = /filename="?([^";]+)"?/.exec(disposition);
      anchor.download = match?.[1] ?? `${template.name}.flocafe-template.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success(t('templateExported'));
    } catch {
      toast.error(t('templateExportFailed'));
    } finally {
      setActingId(null);
    }
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    try {
      const res = await api.post('/print-templates/import', {
        file: text,
        name: file.name.replace(/\.flocafe-template\.json$/i, '') || file.name,
        fileName: file.name,
      });
      const created = res.data?.template as TemplateRow;
      toast.success(t('templateImported'));
      await loadTemplates();
      if (created) await openEdit(created);
    } catch {
      toast.error(t('templateImportFailed'));
    }
  };

  const moveBlock = (index: number, delta: -1 | 1) => {
    if (!draftPayload) return;
    const blocks = [...draftPayload.blocks];
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    setDraftPayload({ ...draftPayload, blocks });
  };

  const toggleBlockVisible = (index: number) => {
    if (!draftPayload) return;
    const blocks = draftPayload.blocks.map((block, i) =>
      i === index ? { ...block, visible: block.visible === false ? true : false } : block,
    );
    setDraftPayload({ ...draftPayload, blocks });
  };

  const setBlockLabel = (index: number, field: string, value: string) => {
    if (!draftPayload) return;
    const blocks = draftPayload.blocks.map((block, i) => {
      if (i !== index) return block;
      const labels = { ...(block.labels ?? {}) };
      if (value === '') delete labels[field];
      else labels[field] = value;
      return { ...block, ...(Object.keys(labels).length > 0 ? { labels } : { labels: undefined }) };
    });
    setDraftPayload({ ...draftPayload, blocks });
  };

  /** Renders the editor payload as a receipt-style preview (blocks, order, labels). */
  const previewNode = useMemo(() => {
    if (!draftPayload) return null;
    const blocks = draftPayload.blocks.filter((block) => block.visible !== false);
    const renderBlocks: React.ReactNode[] = [];
    for (const block of blocks) {
      const labels = block.labels;
      switch (block.kind) {
        case 'business-header': {
          renderBlocks.push(
            <div key={block.kind} className="text-center space-y-0.5">
              <p className="text-base font-extrabold tracking-wide">{PREVIEW_DATA.businessName}</p>
            </div>,
          );
          break;
        }
        case 'document-meta': {
          renderBlocks.push(
            <div key={block.kind} className="text-center space-y-0.5">
              <p className="text-sm font-bold">{previewLabel(labels, 'title', PREVIEW_DATA.docTitle)}</p>
              <p className="text-xs opacity-70">{previewLabel(labels, 'invoiceNumber', PREVIEW_DATA.orderNumber)}</p>
            </div>,
          );
          break;
        }
        case 'customer': {
          renderBlocks.push(
            <p key={block.kind} className="text-xs">{t('customerLabel')} {PREVIEW_DATA.customerName}</p>,
          );
          break;
        }
        case 'item-table': {
          const itemCol = previewLabel(labels, 'item', t('itemCol'));
          const qtyCol = previewLabel(labels, 'quantity', t('qtyCol'));
          const amtCol = previewLabel(labels, 'amount', t('amountCol'));
          renderBlocks.push(
            <div key={block.kind} className="space-y-1">
              <div className="flex justify-between text-[11px] opacity-60 border-b border-dashed pb-0.5">
                <span className="flex-1">{itemCol}</span>
                <span className="w-10 text-center">{qtyCol}</span>
                <span className="w-16 text-right">{amtCol}</span>
              </div>
              {PREVIEW_DATA.items.map((item) => (
                <div key={item.name} className="flex justify-between text-xs">
                  <span className="flex-1 pr-2">{item.name}</span>
                  <span className="w-10 text-center">{item.quantity}</span>
                  <span className="w-16 text-right">¥{item.amount.toFixed(2)}</span>
                </div>
              ))}
              {labels?.note && labels.note.trim() !== '' && (
                <p className="text-[11px] opacity-70">{labels.note}</p>
              )}
            </div>,
          );
          break;
        }
        case 'tax-breakdown': {
          renderBlocks.push(
            <div key={block.kind} className="flex justify-between text-xs">
              <span>{t('taxCol')}</span>
              <span>¥{PREVIEW_DATA.tax.toFixed(2)}</span>
            </div>,
          );
          break;
        }
        case 'totals': {
          const subLabel = previewLabel(labels, 'subtotal', t('subtotalCol'));
          const discLabel = previewLabel(labels, 'discount', t('discountCol'));
          const totalLabel = previewLabel(labels, 'grandTotal', t('totalCol'));
          renderBlocks.push(
            <div key={block.kind} className="space-y-0.5">
              <div className="flex justify-between text-xs">
                <span>{subLabel}</span>
                <span>¥{PREVIEW_DATA.subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span>{discLabel}</span>
                <span>¥{PREVIEW_DATA.discount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm font-bold border-t border-dashed pt-0.5">
                <span>{totalLabel}</span>
                <span>¥{PREVIEW_DATA.grandTotal.toFixed(2)}</span>
              </div>
            </div>,
          );
          break;
        }
        case 'payments': {
          renderBlocks.push(
            <div key={block.kind} className="flex justify-between text-xs">
              <span>{PREVIEW_DATA.payment}</span>
              <span>¥{PREVIEW_DATA.paidAmount.toFixed(2)}</span>
            </div>,
          );
          break;
        }
        case 'message': {
          const thankYou = previewLabel(labels, 'thankYou', t('thankYouLabel'));
          const reprint = previewLabel(labels, 'reprintBanner', '');
          renderBlocks.push(
            <div key={block.kind} className="text-center space-y-0.5">
              {reprint.trim() !== '' && <p className="text-xs font-bold opacity-70">{reprint}</p>}
              <p className="text-xs">{thankYou}</p>
            </div>,
          );
          break;
        }
        default:
          break;
      }
    }
    return (
      <div className="rounded-lg border border-input bg-white text-gray-900 p-4 mx-auto w-[300px] shadow-sm">
        <div className="font-mono text-[13px] leading-relaxed space-y-2">{renderBlocks}</div>
        <div className="mt-3 text-center text-[10px] text-gray-400 border-t border-dashed pt-1">---</div>
      </div>
    );
  }, [draftPayload, t]);

  const statusMeta = useMemo(
    () => ({
      draft: { badge: t('templateStatusDraft'), className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' },
      active: { badge: t('templateStatusActive'), className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300' },
      archived: { badge: t('templateStatusArchived'), className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
    }),
    [t],
  );

  const originBadge = (origin: TemplateRow['origin']) =>
    origin === 'created'
      ? t('templateOriginCreated')
      : origin === 'imported'
        ? t('templateOriginImported')
        : t('templateOriginCloned');

  if (!canView) {
    return (
      <SettingsTabShell title={t('tabPrintTemplates')}>
        <div className="flex items-center gap-2 p-4 bg-gray-100 dark:bg-gray-800/60 rounded-lg">
          <ShieldAlert size={16} className="text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground">{t('printTemplatesNoPermission')}</p>
        </div>
      </SettingsTabShell>
    );
  }

  // --- Editor view ---------------------------------------------------------
  if (editing && draftPayload) {
    const blocks = draftPayload.blocks;
    return (
      <SettingsTabShell title={t('tabPrintTemplates')}>
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={closeEditor}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft size={16} />
            {t('backToTemplates')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void persist(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
            >
              <Save size={14} />
              {t('templateSave')}
            </button>
            {editing.id !== null && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void persist(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                <CheckCircle2 size={14} />
                {t('templateSaveAndActivate')}
              </button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">{t('templateName')}</label>
          <input
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder={t('templateNamePlaceholder')}
            className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">{t('templateBlocksLabel')}</p>
            <p className="text-sm text-muted-foreground">{t('templateBlocksHint')}</p>
            {blocks.map((block, index) => {
            const kind = block.kind;
            const labelFields = BLOCK_LABEL_FIELDS[kind] ?? [];
            const visible = block.visible !== false;
            return (
              <div
                key={kind}
                className={`rounded-lg border border-input bg-card p-4 space-y-3 ${visible ? '' : 'opacity-50'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText size={16} className="text-muted-foreground shrink-0" />
                    <p className="font-medium text-foreground truncate">{t(BLOCK_KIND_KEYS[kind as keyof typeof BLOCK_KIND_KEYS] ?? 'blockKindDocumentMeta')}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => moveBlock(index, -1)}
                      className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                      aria-label={t('moveUp')}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      disabled={index === blocks.length - 1}
                      onClick={() => moveBlock(index, 1)}
                      className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                      aria-label={t('moveDown')}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <Toggle value={visible} onChange={() => toggleBlockVisible(index)} label={t('blockVisible')} />
                  </div>
                </div>
                {labelFields.length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {labelFields.map((field) => (
                      <label key={field} className="block">
                        <span className="mb-1 block text-xs text-muted-foreground">{t(LABEL_FIELD_KEYS[field as keyof typeof LABEL_FIELD_KEYS] ?? 'labelFieldItem')}</span>
                        <input
                          type="text"
                          value={block.labels?.[field] ?? ''}
                          onChange={(e) => setBlockLabel(index, field, e.target.value)}
                          placeholder={t('templateLabelPlaceholder')}
                          className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          </div>

          {/* Live preview pane */}
          <div className="space-y-2 self-start lg:sticky lg:top-4">
            <p className="text-sm font-medium text-foreground">{t('previewTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('previewHint')}</p>
            <div className="bg-muted/60 rounded-xl p-4">{previewNode}</div>
          </div>
        </div>
      </SettingsTabShell>
    );
  }

  // --- List view -----------------------------------------------------------
  return (
    <SettingsTabShell title={t('tabPrintTemplates')}>
      <p className="text-sm text-muted-foreground">{t('printTemplatesHint')}</p>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus size={15} />
            {t('templateNew')}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            <Upload size={15} />
            {t('templateImport')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importFile(file);
            }}
          />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={22} className="animate-spin text-muted-foreground" />
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-input p-8 text-center">
          <FileText size={28} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('templateListEmpty')}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {templates.map((template) => {
            const meta = statusMeta[template.status];
            return (
              <div key={template.id} className="rounded-lg border border-input bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">{template.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>
                        {meta.badge}
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-muted-foreground dark:bg-gray-800">
                        {originBadge(template.origin)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(template.status === 'draft' || template.status === 'active') && (
                    <button
                      type="button"
                      disabled={actingId === template.id}
                      onClick={() => void openEdit(template)}
                      className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                    >
                      <Pencil size={12} />
                      {t('templateEdit')}
                    </button>
                  )}
                  {canManage && template.status === 'draft' && (
                    <button
                      type="button"
                      disabled={actingId === template.id}
                      onClick={() => void runAction(template.id, 'activate')}
                      className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      <CheckCircle2 size={12} />
                      {t('templateActivate')}
                    </button>
                  )}
                  {canManage && template.status === 'active' && (
                    <button
                      type="button"
                      disabled={actingId === template.id}
                      onClick={() => void runAction(template.id, 'archive')}
                      className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                    >
                      <Archive size={12} />
                      {t('templateArchive')}
                    </button>
                  )}
                  {canManage && template.hasPreviousPayload && template.status === 'active' && (
                    <button
                      type="button"
                      disabled={actingId === template.id}
                      onClick={() => void runAction(template.id, 'rollback')}
                      className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                    >
                      <RotateCcw size={12} />
                      {t('templateRollback')}
                    </button>
                  )}
                  {canManage && (template.status === 'active' || template.status === 'archived') && (
                    <button
                      type="button"
                      disabled={actingId === template.id}
                      onClick={() => void exportTemplate(template)}
                      className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                    >
                      <Download size={12} />
                      {t('templateExport')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsTabShell>
  );
}
