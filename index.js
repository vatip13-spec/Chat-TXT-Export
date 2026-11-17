import { buildTranscript, defaultDateRules, validateDateRule } from './export-core.js';
import JSZip from './vendor/jszip.js';

const settingsKey = 'chat-txt-export';
const commandName = 'chat-txt-export';
const displayName = '안전한채팅파일추출';

function mount() {
    const context = globalThis.SillyTavern?.getContext?.();
    const settingsHost = document.querySelector('#extensions_settings, #extensions_settings2');
    const buttonHost = document.querySelector('#rightSendForm') ?? document.querySelector('#leftSendForm');
    if (!context?.extensionSettings || !settingsHost || document.querySelector('#chat-txt-export')) return;

    const settings = context.extensionSettings[settingsKey] ??= {};
    settings.textMode = settings.textMode === 'original' ? 'original' : 'translation';
    settings.fileMode = settings.fileMode === 'daily' ? 'daily' : 'single';
    settings.showInputButton = settings.showInputButton !== false;
    settings.includeUndatedInFirstDay = settings.includeUndatedInFirstDay === true;
    settings.dateRules = Array.isArray(settings.dateRules)
        ? settings.dateRules.filter(rule => typeof rule?.tag === 'string' && typeof rule?.format === 'string')
        : defaultDateRules.map(rule => ({ ...rule }));

    const panel = document.createElement('div');
    panel.id = 'chat-txt-export';
    panel.className = 'inline-drawer';
    panel.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${displayName}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content"></div>
    `;
    settingsHost.append(panel);

    const drawerContent = panel.querySelector('.inline-drawer-content');
    const controls = document.createElement('div');
    controls.className = 'cte-controls';
    controls.innerHTML = `
        <label class="cte-checkbox">
            <input type="checkbox" data-setting="showInputButton">
            <span>입력창에 다운로드 아이콘 표시</span>
        </label>
        <label class="cte-field">
            본문
            <select class="text_pole" data-setting="textMode">
                <option value="translation">번역 우선 (없으면 원문)</option>
                <option value="original">원문만</option>
            </select>
        </label>
        <label class="cte-field">
            파일
            <select class="text_pole" data-setting="fileMode">
                <option value="single">전체 TXT 한 개</option>
                <option value="daily">일별 TXT를 ZIP으로</option>
            </select>
        </label>
        <div class="cte-rules" hidden>
            <label class="cte-checkbox">
                <input type="checkbox" data-setting="includeUndatedInFirstDay">
                <span>첫 날짜 이전 메시지도 첫날 파일에 포함</span>
            </label>
            <p>인포블럭 태그와 날짜 부분의 형식을 등록하세요.</p>
            <div class="cte-rule-list"></div>
            <button type="button" class="menu_button cte-add-rule">날짜 형식 추가</button>
            <p class="cte-rule-error" aria-live="polite"></p>
        </div>
    `;
    drawerContent.append(controls);

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'chat-txt-export-button';
    button.innerHTML = '<i class="fa-solid fa-file-arrow-down" aria-hidden="true"></i>';
    buttonHost?.prepend(button);

    const rulesBox = controls.querySelector('.cte-rules');
    const ruleList = controls.querySelector('.cte-rule-list');
    const ruleError = controls.querySelector('.cte-rule-error');
    let popupDownload = null;
    let popupStatus = null;
    let exporting = false;

    function updateMode() {
        const daily = settings.fileMode === 'daily';
        rulesBox.hidden = !daily;
        button.hidden = !settings.showInputButton;
        button.title = daily ? '챗 일별 ZIP 다운로드' : '챗 TXT 다운로드';
        button.setAttribute('aria-label', button.title);
        if (popupDownload) popupDownload.textContent = daily ? '일별 ZIP 받기' : 'TXT 받기';
        if (popupStatus) popupStatus.textContent = '';
    }

    function validateRules() {
        ruleError.textContent = '';
        for (const [index, rule] of settings.dateRules.entries()) {
            if (!rule.tag.trim() && !rule.format.trim()) continue;
            const error = validateDateRule(rule);
            if (!error) continue;
            ruleError.textContent = `${index + 1}번째 형식. ${error}`;
            break;
        }
        return ruleError.textContent;
    }

    function addRuleRow(rule) {
        const row = document.createElement('div');
        row.className = 'cte-rule-row';
        row.innerHTML = `
            <input type="text" class="text_pole" aria-label="인포블럭 태그" placeholder="Scene_Info" spellcheck="false">
            <input type="text" class="text_pole" aria-label="날짜 형식" placeholder="Date: YYYY.MM.DD" spellcheck="false">
            <button type="button" class="menu_button" aria-label="날짜 형식 삭제" title="날짜 형식 삭제">×</button>
        `;
        const [tag, format] = row.querySelectorAll('input');
        for (const [element, key] of [[tag, 'tag'], [format, 'format']]) {
            element.value = rule[key];
            element.addEventListener('input', () => {
                rule[key] = element.value;
                validateRules();
                context.saveSettingsDebounced();
            });
        }
        row.querySelector('button').addEventListener('click', () => {
            settings.dateRules.splice(settings.dateRules.indexOf(rule), 1);
            row.remove();
            validateRules();
            context.saveSettingsDebounced();
        });
        ruleList.append(row);
        return tag;
    }

    for (const field of controls.querySelectorAll('[data-setting]')) {
        const key = field.dataset.setting;
        const property = field.type === 'checkbox' ? 'checked' : 'value';
        field[property] = settings[key];
        field.addEventListener('change', () => {
            settings[key] = field[property];
            updateMode();
            context.saveSettingsDebounced();
        });
    }
    for (const rule of settings.dateRules) addRuleRow(rule);
    controls.querySelector('.cte-add-rule').addEventListener('click', () => {
        const rule = { tag: '', format: '' };
        settings.dateRules.push(rule);
        addRuleRow(rule).focus();
    });
    updateMode();
    validateRules();

    function setExporting(value) {
        exporting = value;
        button.disabled = value;
        if (popupDownload) popupDownload.disabled = value;
    }

    function notify(type, message) {
        if (popupStatus) popupStatus.textContent = message;
        else globalThis.toastr?.[type]?.(message);
    }

    async function exportChat() {
        if (exporting) return;
        if (popupStatus) popupStatus.textContent = '';
        const current = globalThis.SillyTavern.getContext();
        const chatId = current.getCurrentChatId?.() ?? current.chatId;
        if (chatId == null || chatId === '' || !Array.isArray(current.chat) || !current.chat.length) {
            notify('info', '내보낼 챗을 열어주세요.');
            return;
        }

        const daily = settings.fileMode === 'daily';
        if (daily && validateRules()) {
            if (!popupStatus) notify('warning', ruleError.textContent);
            return;
        }
        setExporting(true);
        try {
            const files = buildTranscript(current.chat, settings);
            if (!files.size) {
                notify('info', '내보낼 메시지가 없습니다.');
                return;
            }
            const basename = String(chatId).replace(/\.jsonl$/i, '')
                .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/\.+$/, '').slice(0, 100) || 'chat';
            if (daily) {
                const zip = new JSZip();
                for (const [filename, text] of files) zip.file(filename, text);
                const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
                download(archive, `${basename}-일별.zip`);
            } else {
                const text = new Blob([files.get(null)], { type: 'text/plain;charset=utf-8' });
                download(text, `${basename}.txt`);
            }
        } catch (error) {
            console.error(`[${displayName}]`, error);
            notify('error', '챗 파일을 만들지 못했습니다.');
        } finally {
            setExporting(false);
        }
    }

    async function openExportPopup() {
        if (popupDownload) return;

        const content = document.createElement('div');
        content.className = 'cte-popup';
        content.innerHTML = `
            <h3>${displayName}</h3>
            <div class="cte-popup-settings"></div>
            <button type="button" class="menu_button cte-popup-download"></button>
            <p class="cte-popup-status" role="status"></p>
        `;
        content.querySelector('.cte-popup-settings').append(controls);
        popupDownload = content.querySelector('.cte-popup-download');
        popupStatus = content.querySelector('.cte-popup-status');
        popupDownload.disabled = exporting;
        popupDownload.addEventListener('click', exportChat);
        updateMode();

        try {
            const popup = new context.Popup(content, context.POPUP_TYPE.TEXT, '', {
                okButton: '닫기',
                leftAlign: true,
                allowVerticalScrolling: true,
            });
            await popup.show();
        } catch (error) {
            console.error(`[${displayName}]`, error);
            globalThis.toastr?.error('내보내기 설정창을 열지 못했습니다.');
        } finally {
            drawerContent.append(controls);
            popupDownload = null;
            popupStatus = null;
        }
    }

    button.addEventListener('click', exportChat);

    const wandMenu = document.querySelector('#extensionsMenu');
    if (wandMenu) {
        const wandItem = document.createElement('a');
        wandItem.id = 'chat-txt-export-wand';
        wandItem.tabIndex = 0;
        wandItem.setAttribute('role', 'button');
        wandItem.innerHTML = `<i class="fa-lg fa-solid fa-file-arrow-down" aria-hidden="true"></i><span>${displayName}</span>`;
        wandItem.addEventListener('click', openExportPopup);
        wandItem.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            wandItem.click();
        });
        wandMenu.append(wandItem);
    }

    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name: commandName,
        helpString: `${displayName} 설정창을 엽니다. 창에서 TXT 또는 일별 ZIP을 받을 수 있습니다.`,
        callback: () => {
            void openExportPopup();
            return '';
        },
    }));
}

function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
    mount();
}
