import '@material/web/menu/menu.js';
import '@material/web/menu/menu-item.js';

export interface MaterialSelectOption {
    label: string;
    value: string;
}

export interface MaterialMenuSelectConfig {
    dataRole?: string;
    menuDataRole?: string;
    buttonDataRole?: string;
    ariaLabel?: string;
    className?: string;
}

export interface MaterialMenuSelect {
    wrapper: HTMLElement;
    select: HTMLSelectElement;
    button: HTMLButtonElement;
    menu: HTMLElement;
    syncFromSelect(): void;
    setValue(value: string, emitChange?: boolean): void;
}

type MdMenuElement = HTMLElement & {
    anchorElement?: HTMLElement;
    defaultFocus?: string;
    open?: boolean;
    positioning?: string;
    quick?: boolean;
};

type MdMenuItemElement = HTMLElement & {
    keepOpen?: boolean;
    selected?: boolean;
    typeaheadText?: string;
};

let materialSelectId = 0;

function attachSelectRipple(element: HTMLElement): void {
    if (element.querySelector('md-ripple')) return;
    const ripple = document.createElement('md-ripple');
    ripple.setAttribute('aria-hidden', 'true');
    element.prepend(ripple);
}

function getSelectedOption(select: HTMLSelectElement): HTMLOptionElement | null {
    return select.selectedOptions[0] ?? select.options[select.selectedIndex] ?? null;
}

function createHeadline(text: string): HTMLElement {
    const headline = document.createElement('div');
    headline.slot = 'headline';
    headline.textContent = text;
    return headline;
}

export function createMaterialMenuSelect(
    options: MaterialSelectOption[],
    selectedValue: string,
    onChange: (value: string) => void,
    config: MaterialMenuSelectConfig = {},
): MaterialMenuSelect {
    const id = `q3d-material-select-${++materialSelectId}`;
    const wrapper = document.createElement('div');
    wrapper.className = ['q3d-material-select', config.className].filter(Boolean).join(' ');

    const select = document.createElement('select');
    select.className = 'q3d-setting-control q3d-native-select-shadow md-typescale-body-medium';
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    if (config.dataRole) select.setAttribute('data-role', config.dataRole);

    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = 'q3d-material-select-button md-typescale-body-medium';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', config.ariaLabel ?? 'Select option');
    if (config.buttonDataRole) button.setAttribute('data-role', config.buttonDataRole);
    attachSelectRipple(button);

    const valueText = document.createElement('span');
    valueText.className = 'q3d-material-select-value';
    valueText.setAttribute('data-role', 'material-select-value');

    const arrow = document.createElement('span');
    arrow.className = 'q3d-material-select-arrow';
    arrow.setAttribute('aria-hidden', 'true');

    button.appendChild(valueText);
    button.appendChild(arrow);

    const menu = document.createElement('md-menu') as MdMenuElement;
    menu.className = 'q3d-material-menu';
    menu.setAttribute('anchor', id);
    menu.setAttribute('aria-label', config.ariaLabel ?? 'Options');
    if (config.menuDataRole) menu.setAttribute('data-role', config.menuDataRole);
    menu.anchorElement = button;
    menu.quick = true;
    menu.positioning = 'fixed';
    menu.defaultFocus = 'list-root';

    const updateButtonLabel = () => {
        const selected = getSelectedOption(select);
        valueText.textContent = selected?.textContent ?? select.value;
        button.title = valueText.textContent || '';
    };

    const syncSelectedItems = () => {
        for (const item of Array.from(menu.querySelectorAll('md-menu-item')) as MdMenuItemElement[]) {
            const selected = item.dataset.value === select.value;
            item.selected = selected;
            item.toggleAttribute('selected', selected);
            item.setAttribute('aria-selected', selected ? 'true' : 'false');
        }
    };

    const setValue = (value: string, emitChange = false) => {
        const changed = select.value !== value;
        if (changed) select.value = value;
        updateButtonLabel();
        syncSelectedItems();
        if (emitChange && changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const syncFromSelect = () => {
        menu.innerHTML = '';
        for (const option of Array.from(select.options)) {
            const item = document.createElement('md-menu-item') as MdMenuItemElement;
            item.dataset.value = option.value;
            item.typeaheadText = option.textContent ?? option.value;
            item.keepOpen = false;
            item.toggleAttribute('disabled', option.disabled);
            item.appendChild(createHeadline(option.textContent ?? option.value));
            item.addEventListener('click', () => setValue(option.value, true));
            menu.appendChild(item);
        }
        updateButtonLabel();
        syncSelectedItems();
    };

    const toggleMenu = (event: Event | KeyboardEvent) => {
        const key = (event as KeyboardEvent).key;
        if (key && key !== 'Enter' && key !== ' ' && key !== 'ArrowDown') return;
        event.preventDefault();
        menu.open = !menu.open;
        button.setAttribute('aria-expanded', menu.open ? 'true' : 'false');
    };

    select.onchange = () => {
        updateButtonLabel();
        syncSelectedItems();
        onChange(select.value);
    };

    button.addEventListener('click', toggleMenu);
    button.addEventListener('keydown', toggleMenu);
    menu.addEventListener('closed', () => button.setAttribute('aria-expanded', 'false'));
    menu.addEventListener('close-menu', (event) => {
        const target = (event as CustomEvent<{ initiator?: EventTarget }>).detail?.initiator as HTMLElement | undefined;
        const value = target?.dataset?.value;
        if (value) setValue(value, true);
    });

    for (const option of options) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.label;
        el.selected = option.value === selectedValue;
        select.appendChild(el);
    }
    if (!Array.from(select.options).some(option => option.selected) && select.options.length > 0) {
        select.options[0].selected = true;
    }

    wrapper.appendChild(select);
    wrapper.appendChild(button);
    wrapper.appendChild(menu);
    syncFromSelect();

    return { wrapper, select, button, menu, syncFromSelect, setValue };
}
