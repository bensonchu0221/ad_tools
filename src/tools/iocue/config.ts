// tool#11 IO／Cue 單的固定設定：開票主體（受託方）資料、預設條款。
// 受託方資料：2026-11-20 使用者提供博英統編、代表人、資本額、地址；全銜、電話、匯款帳戶「先留空白」（PDF 空的欄位不印，
//   全銜空白時印簡稱「博英」）。行家公司已不存在，拿掉。
// 章：使用者說先用示意章（CSS 畫的），之後拿到去背 PNG 再換（放 GCS iocue/_stamps/<entity>-contract.png、-quote.png）。
import type { EntityInfo, PdfTerm } from './pdf_template.js';
import type { Entity } from './model.js';

export const ENTITY_INFO: Record<Entity, EntityInfo> = {
  博英: {
    key: '博英', fullName: '', taxId: '52633245', address: '臺北市中山區南京東路3段77號11樓', phone: '',
    bank: '', accountName: '', accountNo: '', rep: '申芳萍', capital: 500000,
  },
};

/** 條款範本（版本化：PDF 記下用的是哪一版；改條款＝新增一版，不改舊版）。{net} 會換成 IO 未稅總額。 */
export interface TermsTemplate { version: string; label: string; terms: PdfTerm[] }
export const TERMS: TermsTemplate[] = [
  {
    version: 'std-2026.11', label: '標準條款 2026.11 版',
    terms: [
      { title: '排程與預算微調授權', body: '在未稅總金額（{net}）及總走期不變之前提下，受託方得依各媒體平台實際投放成效，經雙方窗口確認新版 Cue 表後調整各平台或波段預算分配，無須另行重簽本委刊單。' },
      { title: '素材交付與上刊時程', body: '委刊方應於預計上刊日前至少 3 個工作日提供符合規範之廣告素材；若因委刊方延遲交付導致走期延誤，相關預算仍依原約定結算。' },
      { title: '成效數據與結算基準', body: '本表所列預估量體與目標單價（CPC / CPM / CPA）為執行監控基準，實際結算金額與成效數據以各媒體平台官方後台報表為準。' },
      { title: '文件效力', body: '本委刊單經雙方用印後（含蓋章掃描電子檔回傳或系統電子簽署確認）即生正式合約效力，與紙本正本具同等法律效力。' },
    ],
  },
];
export const DEFAULT_TERMS = TERMS[0].version;
export const termsOf = (version: string) => TERMS.find((t) => t.version === version) ?? TERMS[0];

export const PAYMENT_TERMS = ['月結 30 天 / 電匯', '月結 60 天 / 電匯', '預付'];
