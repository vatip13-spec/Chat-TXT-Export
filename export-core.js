export const defaultDateRules = [
    { tag: 'Scene_Info', format: 'Date: YYYY.MM.DD' },
    { tag: 'info_panel', format: '날짜: YYYY/MM/DD' },
];

const tagNamePattern = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const formatTokens = /YYYY|MM|DD/g;
const markup = /<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;

export function normalizeTag(value) {
    return value.trim().replace(/^<([^<>]+)>$/, '$1').trim();
}

export function validateDateRule(rule) {
    if (!tagNamePattern.test(normalizeTag(rule.tag))) {
        return '인포블럭 태그 이름을 입력하세요.';
    }

    const tokens = rule.format.match(formatTokens) ?? [];
    if (tokens.length !== 3 || !['YYYY', 'MM', 'DD'].every(token => tokens.includes(token))) {
        return '날짜 형식에 YYYY, MM, DD를 각각 한 번씩 넣으세요.';
    }
    return '';
}

function escapeRegex(value) {
    return value.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
}

function compileDateFormat(format) {
    const groups = { YYYY: 'year', MM: 'month', DD: 'day' };
    const template = format.trim();
    let lastIndex = 0;
    let pattern = '';
    const literal = text => escapeRegex(text).replace(/[^\S\r\n]+/g, '[^\\S\\r\\n]*');

    for (const token of template.matchAll(formatTokens)) {
        pattern += literal(template.slice(lastIndex, token.index));
        pattern += `(?<${groups[token[0]]}>\\d{${token[0] === 'YYYY' ? '4' : '1,2'}})`;
        lastIndex = token.index + token[0].length;
    }
    pattern += literal(template.slice(lastIndex));
    return new RegExp(`(?:^|\\|)[^\\S\\r\\n]*${pattern}(?!\\d)`, 'gim');
}

export function compileDateRules(rules) {
    const formatsByTag = new Map();
    for (const rule of rules) {
        if (validateDateRule(rule)) continue;
        const tag = normalizeTag(rule.tag).toLowerCase();
        if (!formatsByTag.has(tag)) formatsByTag.set(tag, []);
        formatsByTag.get(tag).push(compileDateFormat(rule.format));
    }

    if (!formatsByTag.size) return null;
    const alternatives = [...formatsByTag.keys()].map(escapeRegex).join('|');
    const attributes = `(?:[^"'<>]|"[^"]*"|'[^']*')*`;
    const blocks = new RegExp(`<(${alternatives})(?=[\\s>])${attributes}>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
    return { blocks, formatsByTag };
}

function toIsoDate({ year, month, day }) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (y < 1 || m < 1 || m > 12 || d < 1) return null;

    const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (d > daysPerMonth[m - 1]) return null;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function dateFromInfoBlock(original, rules) {
    if (!rules || !original) return null;
    for (const block of original.matchAll(rules.blocks)) {
        const text = block[2].replace(/<br\s*\/?>/gi, '\n').replace(markup, '').replace(/\*\*|__/g, '');
        let firstMatch = null;
        for (const format of rules.formatsByTag.get(block[1].toLowerCase())) {
            for (const match of text.matchAll(format)) {
                const date = toIsoDate(match.groups);
                if (!date) continue;
                if (!firstMatch || match.index < firstMatch.index) {
                    firstMatch = { date, index: match.index };
                }
                break;
            }
        }
        if (firstMatch) return firstMatch.date;
    }
    return null;
}

function storedText(value) {
    return typeof value === 'string' && value.trim() ? value : '';
}

function getMessageTexts(message) {
    const body = storedText(message.mes);
    const display = storedText(message.extra?.display_text);
    const savedOriginal = storedText(message.extra?.original_mes);
    const translationIsForCurrentSwipe = message.extra?.cat_swipe_id == null
        || message.swipe_id == null
        || message.extra.cat_swipe_id === message.swipe_id;

    if (!translationIsForCurrentSwipe) return { original: body, translation: '' };
    if (savedOriginal) return { original: savedOriginal, translation: display };
    if (message.is_user && body && display) {
        // SillyTavern's built-in outgoing translation stores typed text in display_text.
        return { original: display, translation: body };
    }
    return { original: body, translation: display };
}

export function buildTranscript(chat, { textMode, fileMode, dateRules, includeUndatedInFirstDay }) {
    const groupedTurns = new Map();
    const daily = fileMode === 'daily';
    const rules = daily ? compileDateRules(dateRules) : null;
    let date = null;

    for (const message of chat) {
        if (!message || (message.is_system && message.extra?.uses_system_ui)) continue;
        const { original, translation } = getMessageTexts(message);
        const text = textMode === 'original' ? original : translation || original;
        const messageDate = dateFromInfoBlock(original, rules);
        if (messageDate && date === null && includeUndatedInFirstDay && groupedTurns.has(null)) {
            groupedTurns.set(messageDate, groupedTurns.get(null));
            groupedTurns.delete(null);
        }
        date = messageDate ?? date;
        if (!text) continue;

        const name = typeof message.name === 'string' && message.name.trim()
            ? message.name.replace(/[\r\n]+/g, ' ').trim()
            : message.is_user ? '페르소나' : '캐릭터';
        if (!groupedTurns.has(date)) groupedTurns.set(date, []);
        const body = text.replace(/[\r\n]+$/, '');
        groupedTurns.get(date).push(`${name}\n${body}\n----------`);
    }

    return new Map([...groupedTurns].map(([day, turns]) => {
        const filename = daily ? `${day ?? '날짜 미지정'}.txt` : null;
        return [filename, turns.join('\n\n') + '\n'];
    }));
}
