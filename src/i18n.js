import en from '../_locales/en/messages.json';
import ja from '../_locales/ja/messages.json';

export const language = (globalThis.chrome?.i18n?.getUILanguage() || navigator.language).toLowerCase().startsWith('ja') ? 'ja' : 'en';
const messages = language === 'ja' ? ja : en;
export const t = key => messages[key].message;
