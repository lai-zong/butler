/**
 * 本地登录的找回问题。
 *
 * ★ 只做本机单一用户：不是高安全凭据，答案只做哈希保存。
 *   问题固定，避免用户自定义一个"答案是 1"的伪安全问题。
 */

export const SECURITY_QUESTIONS = [
  { id: 'first-pet', label: '你的第一只宠物叫什么？' },
  { id: 'primary-teacher', label: '你小学班主任姓什么？' },
  { id: 'favorite-book', label: '你最喜欢的一本书是什么？' },
  { id: 'birth-city', label: '你出生在哪个城市？' },
  { id: 'first-job', label: '你的第一份工作或实习在哪里？' },
  { id: 'favorite-place', label: '你最常去的城市是哪里？' },
] as const;

export type SecurityQuestionId = (typeof SECURITY_QUESTIONS)[number]['id'];

export function securityQuestionById(id: string): { readonly id: string; readonly label: string } | null {
  return SECURITY_QUESTIONS.find((question) => question.id === id) ?? null;
}

export function isSecurityQuestionId(value: unknown): value is SecurityQuestionId {
  return typeof value === 'string' && SECURITY_QUESTIONS.some((question) => question.id === value);
}
