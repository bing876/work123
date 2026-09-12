/**
 * 第 9 步：输入框敏感分类 —— 全工程**唯一**判定源。
 *
 * 页面侧脚本只负责收集字段事实（type/name/placeholder/label/maxlength…），
 * 分类一律进这个函数：driver 的快照、执行器守卫、以后调误判都只改这里。
 *
 * 规则（保守，宁可多判敏感）：
 *   1) type === 'password'                          → sensitive: password
 *   2) 文本含 验证码/校验码/动态口令/短信码/otp/verification/captcha
 *      → sensitive: otp_guess
 *   3) 文本含 code 且「短数字输入」（maxlength≤8 / inputmode=numeric / type=tel|number）
 *      → sensitive: otp_guess（单有 code 太宽——zipcode/area code 场景由 2 的关键词兜住）
 *   4) 文本含 支付/付款/银行卡/卡号/cvv/安全码/payment/checkout/card number/收银台
 *      → sensitive: payment_guess
 *   5) 文本含 身份证/idcard/id card                        → sensitive: id_guess
 *   6) 其余                                            → normal
 * 附带：点击守卫 isPaymentConfirmAction——按钮文案命中支付最终确认词，AI 一律不代点。
 */
export type FieldKind = 'sensitive' | 'normal';
export type FieldReason = 'password' | 'otp_guess' | 'payment_guess' | 'id_guess' | 'normal';

/** 页面脚本采集的字段事实（不含任何 value —— 敏感字段连值都不碰） */
export interface FieldDescriptor {
  tag: string;
  type: string;
  name: string;
  id: string;
  ph: string;
  aria: string;
  lbl: string;
  maxlength: number | null;
  inputmode: string;
  editable: boolean;
}

const OTP_RE = /(验证码|校验码|动态口令|短信码|一次性密码|verification\s*code|verif|otp|captcha|短信|动态码)/i;
const CODE_RE = /(code)/i;
const PAY_RE = /(支付|付款|银行卡|信用卡|借记卡|卡号|cvv|cvc|安全码|payment|paynow|pay\s*now|checkout|card\s*number|收银台|收款)/i;
const ID_RE = /(身份证|id\s*card|idcard)/i;

/** 把描述里所有可匹配文本拼成一条小写串 */
function hay(d: Partial<FieldDescriptor>): string {
  return [d.type, d.name, d.id, d.ph, d.aria, d.lbl]
    .map((x) => (typeof x === 'string' ? x : ''))
    .join(' ')
    .toLowerCase();
}

function shortNumericish(d: Partial<FieldDescriptor>): boolean {
  const ml = typeof d.maxlength === 'number' ? d.maxlength : null;
  const im = (d.inputmode ?? '').toLowerCase();
  const t = (d.type ?? '').toLowerCase();
  return (ml !== null && ml > 0 && ml <= 8) || im === 'numeric' || im === 'tel' || t === 'tel' || t === 'number';
}

export function classifyField(d: Partial<FieldDescriptor>): { kind: FieldKind; reason: FieldReason } {
  if ((d.type ?? '').toLowerCase() === 'password') return { kind: 'sensitive', reason: 'password' };
  const h = hay(d);
  if (OTP_RE.test(h)) return { kind: 'sensitive', reason: 'otp_guess' };
  if (CODE_RE.test(h) && shortNumericish(d)) return { kind: 'sensitive', reason: 'otp_guess' };
  if (PAY_RE.test(h)) return { kind: 'sensitive', reason: 'payment_guess' };
  if (ID_RE.test(h)) return { kind: 'sensitive', reason: 'id_guess' };
  return { kind: 'normal', reason: 'normal' };
}

export const FIELD_REASON_CN: Record<FieldReason, string> = {
  password: '密码',
  otp_guess: '验证码/动态口令',
  payment_guess: '支付信息',
  id_guess: '身份证号',
  normal: '普通资料',
};

/**
 * 点击守卫：模型想点的按钮文案命中“支付/收银台最终确认”类词 → AI 不代点（说明书红线）。
 * 页面侧拿到 label 后调用；宁可多拦，用户自己点不受影响。
 */
const PAY_ACTION_RE = /(立即支付|确认支付|确认付款|去支付|去付款|提交订单|确认订单|付款|支付|pay\s*now|pay\s*order|checkout|place\s*order|确认支付并)/i;
export function isPaymentConfirmAction(label: string): boolean {
  return PAY_ACTION_RE.test(String(label ?? ''));
}
