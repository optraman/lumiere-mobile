"use strict";
// Портировано из data/model/Media.kt (Android TV приложение) — только то, что нужно каталогу.
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatRuDate = formatRuDate;
exports.isFutureDate = isFutureDate;
const RU_MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
/** "15 марта 2026" из "YYYY-MM-DD" — null, если распарсить не удалось. */
function formatRuDate(date) {
    if (!date)
        return null;
    const parts = date.split('-');
    if (parts.length !== 3)
        return null;
    const day = parseInt(parts[2], 10);
    const monthIdx = parseInt(parts[1], 10) - 1;
    const month = RU_MONTHS[monthIdx];
    if (!month || Number.isNaN(day))
        return null;
    return `${day} ${month} ${parts[0]}`;
}
function isFutureDate(date) {
    if (!date)
        return false;
    const target = new Date(date + 'T00:00:00');
    if (Number.isNaN(target.getTime()))
        return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return target.getTime() > today.getTime();
}
