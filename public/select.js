/** Enhance native selects while retaining their values, options and form events. */
export function enhanceSelects() {
  /** @type {(() => void)[]} */
  const updates = [];
  /** @type {(() => void) | undefined} */
  let closeCurrent;

  for (const node of document.querySelectorAll('select.field-control--select')) {
    if (!(node instanceof HTMLSelectElement)) continue;
    const select = node;
    const wrapper = document.createElement('div');
    wrapper.className = 'select-control';
    select.before(wrapper);
    wrapper.append(select);
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = `${select.id}-trigger`;
    trigger.className = 'field-control select-control__trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const value = document.createElement('span');
    value.className = 'select-control__value';
    trigger.append(value);
    const label = select.labels?.[0];
    if (label) {
      label.id ||= `${select.id}-label`;
      trigger.setAttribute('aria-labelledby', label.id);
      label.htmlFor = trigger.id;
    }
    const menu = document.createElement('div');
    menu.id = `${select.id}-options`;
    menu.className = 'select-control__menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', label?.id ?? trigger.id);
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    wrapper.append(trigger, menu);
    select.classList.add('select-control__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.addEventListener('focus', () => trigger.focus());
    /** @type {HTMLOptionElement[]} */
    let options = [];
    let active = -1;
    let typed = '';
    let typedAt = 0;

    function close() {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      typed = '';
      if (closeCurrent === close) closeCurrent = undefined;
    }

    function position() {
      if (menu.hidden) return;
      const box = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      if (!trigger.getClientRects().length || box.bottom < top || box.top > top + height) { close(); return; }
      const below = top + height - box.bottom - 12;
      const above = box.top - top - 12;
      menu.style.width = `${Math.min(box.width, width - 24)}px`;
      const upwards = below < Math.min(menu.scrollHeight, 280) && above > below;
      menu.style.left = `${Math.max(left + 12, Math.min(box.left, left + width - menu.offsetWidth - 12))}px`;
      menu.style.maxHeight = `${Math.max(48, Math.min(320, upwards ? above : below))}px`;
      menu.style.top = `${upwards ? box.top - menu.offsetHeight - 6 : box.bottom + 6}px`;
    }

    /** @param {number} index */
    function activate(index) {
      if (!options[index] || options[index].disabled) return;
      active = index;
      for (const [i, item] of Array.from(menu.children).entries()) {
        if (item instanceof HTMLElement) item.dataset.active = String(i === active);
      }
      const item = menu.children[active];
      if (!(item instanceof HTMLElement)) return;
      trigger.setAttribute('aria-activedescendant', item.id);
      // Scroll only the popup; scrollIntoView can move the entire planning form.
      if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }

    function sync() {
      value.textContent = select.selectedOptions[0]?.label ?? '请选择';
      trigger.disabled = select.disabled;
      wrapper.hidden = select.hidden;
      trigger.dataset.placeholder = String(!select.value);
      for (const attr of ['aria-invalid', 'aria-describedby', 'aria-busy']) {
        const attribute = select.getAttribute(attr);
        if (attribute === null) trigger.removeAttribute(attr);
        else trigger.setAttribute(attr, attribute);
      }
      trigger.setAttribute('aria-required', String(select.required));
      if (!menu.hidden) close();
    }

    function open() {
      if (select.disabled) return;
      closeCurrent?.();
      options = Array.from(select.options).filter((option) => !option.hidden);
      menu.replaceChildren(...options.map((option, index) => {
        const item = document.createElement('div');
        item.id = `${menu.id}-${index}`;
        item.className = 'select-control__option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.selected));
        item.setAttribute('aria-disabled', String(option.disabled));
        item.textContent = option.label;
        item.addEventListener('click', () => commit(index));
        return item;
      }));
      active = -1;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      closeCurrent = close;
      trigger.focus({ preventScroll: true });
      position();
      const selected = options.findIndex((option) => option.selected && !option.disabled);
      activate(selected < 0 ? options.findIndex((option) => !option.disabled) : selected);
    }

    /** @param {number} index */
    function commit(index) {
      const option = options[index];
      if (select.disabled || !option || option.disabled || option.hidden || !select.contains(option)) { close(); return; }
      const changed = select.selectedIndex !== option.index;
      select.selectedIndex = option.index;
      close();
      sync();
      trigger.focus({ preventScroll: true });
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    trigger.addEventListener('click', () => menu.hidden ? open() : close());
    trigger.addEventListener('keydown', (event) => {
      if (event.isComposing || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'Escape') { if (!menu.hidden) event.preventDefault(); close(); return; }
      if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); if (!menu.hidden) commit(active); return; }
      const navigation = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (navigation.includes(event.key)) {
        event.preventDefault();
        const wasOpen = !menu.hidden;
        if (!wasOpen) open();
        const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
        let next = enabled.indexOf(active);
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = enabled.length - 1;
        else if (wasOpen) next += event.key === 'ArrowDown' ? 1 : -1;
        activate(enabled[Math.max(0, Math.min(next, enabled.length - 1))] ?? -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (menu.hidden) open();
        else commit(active);
      } else if (event.key.length === 1 && !event.altKey) {
        event.preventDefault();
        if (menu.hidden) open();
        const now = Date.now();
        typed = now - typedAt > 700 ? event.key : typed + event.key;
        typedAt = now;
        const repeated = Array.from(typed).every((letter) => letter === typed[0]);
        const prefix = (repeated ? event.key : typed).toLocaleLowerCase();
        const start = repeated ? active + 1 : active;
        for (let step = 0; step < options.length; step++) {
          const index = (Math.max(0, start) + step) % options.length;
          const option = options[index];
          if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(prefix)) { activate(index); break; }
        }
      }
    });
    menu.addEventListener('pointerdown', (event) => { if (event.pointerType === 'mouse') event.preventDefault(); });
    document.addEventListener('pointerdown', (event) => { if (event.target instanceof Node && !wrapper.contains(event.target)) close(); });
    document.addEventListener('focusin', (event) => { if (event.target instanceof Node && !wrapper.contains(event.target)) close(); });
    window.addEventListener('resize', close);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', close);
    window.visualViewport?.addEventListener('scroll', position);
    select.addEventListener('input', sync);
    select.addEventListener('change', sync);
    // Dynamic options and disabled/error attributes stay owned by the native field.
    new MutationObserver(sync).observe(select, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected', 'label', 'aria-invalid', 'aria-describedby', 'aria-busy', 'required'] });
    updates.push(sync);
    sync();
  }
  // Programmatic .value assignments do not emit events or attribute mutations.
  return () => { for (const update of updates) update(); };
}
