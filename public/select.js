/** Enhance native selects while retaining their values, options and form events.
 * @param {ParentNode} [root]
 * @param {AbortSignal} [signal]
 */
export function enhanceSelects(root = document, signal) {
  /** @type {(() => void)[]} */
  const updates = [];
  /** @type {(() => void) | undefined} */
  let closeCurrent;

  for (const node of root.querySelectorAll('select.field-control--select')) {
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
    menu.hidden = true;
    const searchLabel = select.getAttribute('data-search');
    const searchable = typeof searchLabel === 'string' && searchLabel.trim() !== '';
    /** @type {HTMLInputElement | undefined} */
    let search;
    /** @type {HTMLElement} */
    let optionsHost = menu;
    if (searchable) {
      menu.classList.add('select-control__menu--search');
      search = document.createElement('input');
      search.type = 'text';
      search.id = `${select.id}-search`;
      search.className = 'field-control select-control__search';
      search.placeholder = searchLabel;
      search.setAttribute('aria-label', searchLabel);
      search.setAttribute('aria-autocomplete', 'list');
      search.autocomplete = 'off';
      search.autocapitalize = 'none';
      search.spellcheck = false;
      search.setAttribute('autocorrect', 'off');
      search.enterKeyHint = 'search';
      const list = document.createElement('div');
      list.id = `${select.id}-listbox`;
      list.className = 'select-control__list';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-labelledby', label?.id ?? trigger.id);
      search.setAttribute('aria-controls', list.id);
      optionsHost = list;
      menu.append(search, list);
    } else {
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-labelledby', label?.id ?? trigger.id);
    }
    trigger.setAttribute('aria-controls', optionsHost.id);
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
    let suppressClose = false;
    const empty = document.createElement('p');
    empty.className = 'select-control__empty';
    empty.textContent = '无匹配币种';

    /** @param {{ focusTrigger?: boolean }} [action] */
    function close(action) {
      const wasOpen = !menu.hidden;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      search?.removeAttribute('aria-activedescendant');
      typed = '';
      if (search) search.value = '';
      if (closeCurrent === close) closeCurrent = undefined;
      if (wasOpen && action?.focusTrigger && search && document.activeElement === search)
        trigger.focus({ preventScroll: true });
    }

    function position() {
      if (menu.hidden) return;
      const box = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      if (!trigger.getClientRects().length || box.bottom < top || box.top > top + height) {
        close();
        return;
      }
      const below = top + height - box.bottom - 12;
      const above = box.top - top - 12;
      menu.style.width = `${Math.min(box.width, width - 24)}px`;
      if (searchable) menu.style.maxHeight = 'none';
      const upwards = below < Math.min(menu.scrollHeight, 280) && above > below;
      menu.style.left = `${Math.max(left + 12, Math.min(box.left, left + width - menu.offsetWidth - 12))}px`;
      menu.style.maxHeight = `${Math.max(48, Math.min(320, upwards ? above : below))}px`;
      menu.style.top = `${upwards ? box.top - menu.offsetHeight - 6 : box.bottom + 6}px`;
    }

    /** @param {number} index */
    function activate(index) {
      if (!options[index] || options[index].disabled) return;
      active = index;
      for (const [i, item] of Array.from(optionsHost.children).entries()) {
        if (item instanceof HTMLElement) item.dataset.active = String(i === active);
      }
      const item = optionsHost.children[active];
      if (!(item instanceof HTMLElement)) return;
      trigger.setAttribute('aria-activedescendant', item.id);
      search?.setAttribute('aria-activedescendant', item.id);
      if (menu.hidden) return;
      const scroller = searchable ? optionsHost : menu;
      // Scroll only the popup; scrollIntoView can move the entire planning form.
      if (item.offsetTop < scroller.scrollTop) scroller.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > scroller.scrollTop + scroller.clientHeight)
        scroller.scrollTop = item.offsetTop + item.offsetHeight - scroller.clientHeight;
    }

    /** @param {'default' | 'preserve'} mode */
    function paint(mode) {
      const previous = mode === 'preserve' ? options[active] : undefined;
      const query = search?.value ?? '';
      const needle = query.toLocaleLowerCase();
      options = Array.from(select.options).filter((option) => {
        if (option.hidden) return false;
        if (!searchable || query === '') return true;
        return option.value !== '' && option.label.toLocaleLowerCase().includes(needle);
      });
      const retained = previous && options.includes(previous) ? options.indexOf(previous) : -1;
      const fallback =
        !searchable || query === ''
          ? options.findIndex((option) => option.selected && !option.disabled)
          : -1;
      const next =
        retained >= 0
          ? retained
          : fallback >= 0
            ? fallback
            : options.findIndex((option) => !option.disabled);
      if (searchable && options.length === 0) {
        optionsHost.replaceChildren(empty);
        active = -1;
        trigger.removeAttribute('aria-activedescendant');
        search?.removeAttribute('aria-activedescendant');
        return;
      }
      optionsHost.replaceChildren(
        ...options.map((option, index) => {
          const item = document.createElement('div');
          item.id = `${optionsHost.id}-${index}`;
          item.className = 'select-control__option';
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', String(option.selected));
          item.setAttribute('aria-disabled', String(option.disabled));
          item.textContent = option.label;
          item.addEventListener('click', () => commit(index));
          return item;
        }),
      );
      if (next < 0) {
        active = -1;
        trigger.removeAttribute('aria-activedescendant');
        search?.removeAttribute('aria-activedescendant');
        return;
      }
      activate(next);
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
      if (menu.hidden) return;
      if (!searchable || select.disabled) close();
      else {
        paint('preserve');
        position();
        if (active >= 0) activate(active);
      }
    }

    /** @param {string} [typed] */
    function open(typed) {
      if (select.disabled) return;
      closeCurrent?.();
      if (search) search.value = typeof typed === 'string' ? typed : '';
      paint('default');
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      closeCurrent = close;
      if (search) {
        search.focus({ preventScroll: true });
        search.setSelectionRange(search.value.length, search.value.length);
      } else trigger.focus({ preventScroll: true });
      position();
      if (active >= 0) activate(active);
    }

    /** @param {number} index */
    function commit(index) {
      const option = options[index];
      if (
        select.disabled ||
        !option ||
        option.disabled ||
        option.hidden ||
        !select.contains(option)
      ) {
        close();
        return;
      }
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

    trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
    trigger.addEventListener('keydown', (event) => {
      if (event.isComposing || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Tab') {
        close();
        return;
      }
      if (event.key === 'Escape') {
        if (!menu.hidden) event.preventDefault();
        close();
        return;
      }
      if (event.altKey && event.key === 'ArrowUp') {
        event.preventDefault();
        if (!menu.hidden) commit(active);
        return;
      }
      const navigation = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (navigation.includes(event.key)) {
        event.preventDefault();
        const wasOpen = !menu.hidden;
        if (!wasOpen) open();
        const enabled = options
          .map((option, index) => (option.disabled ? -1 : index))
          .filter((index) => index >= 0);
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
        if (searchable && search) {
          if (menu.hidden) open(event.key);
          else {
            search.focus({ preventScroll: true });
            search.value += event.key;
            paint('default');
            position();
            if (active >= 0) activate(active);
          }
          return;
        }
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
          if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(prefix)) {
            activate(index);
            break;
          }
        }
      }
    });
    search?.addEventListener('keydown', (event) => {
      if (
        event.isComposing ||
        event.key === 'Process' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      if (event.key === 'Tab') {
        close();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close({ focusTrigger: true });
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
      event.preventDefault();
      if (event.key === 'Enter') {
        if (active >= 0) commit(active);
        return;
      }
      const enabled = options
        .map((option, index) => (option.disabled ? -1 : index))
        .filter((index) => index >= 0);
      if (!enabled.length) return;
      let next = enabled.indexOf(active);
      if (next < 0) next = event.key === 'ArrowDown' ? 0 : enabled.length - 1;
      else
        next = Math.max(
          0,
          Math.min(next + (event.key === 'ArrowDown' ? 1 : -1), enabled.length - 1),
        );
      activate(enabled[next] ?? -1);
    });
    search?.addEventListener('input', () => {
      if (menu.hidden) return;
      paint('default');
      position();
      if (active >= 0) activate(active);
    });
    menu.addEventListener('pointerdown', (event) => {
      if (search && event.target instanceof Node && search.contains(event.target)) return;
      suppressClose = true;
      if (event.pointerType === 'mouse') event.preventDefault();
    });
    menu.addEventListener('pointerup', () => {
      suppressClose = false;
    });
    menu.addEventListener('pointercancel', () => {
      suppressClose = false;
    });
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!(event.target instanceof Node) || wrapper.contains(event.target)) return;
        const takesFocus =
          event.target instanceof Element &&
          Boolean(
            event.target.closest(
              'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
          );
        close({ focusTrigger: Boolean(search) && !takesFocus });
      },
      { signal },
    );
    document.addEventListener(
      'focusin',
      (event) => {
        if (suppressClose) return;
        if (event.target instanceof Node && !wrapper.contains(event.target)) close();
      },
      { signal },
    );
    const onResize = () => {
      if (searchable && !menu.hidden) position();
      else close();
    };
    window.addEventListener('resize', onResize, { signal });
    window.addEventListener('scroll', position, { capture: true, signal });
    window.visualViewport?.addEventListener('resize', onResize, { signal });
    window.visualViewport?.addEventListener('scroll', position, { signal });
    select.addEventListener('input', sync);
    select.addEventListener('change', sync);
    // Dynamic options and disabled/error attributes stay owned by the native field.
    const observer = new MutationObserver(sync);
    observer.observe(select, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'disabled',
        'hidden',
        'selected',
        'label',
        'aria-invalid',
        'aria-describedby',
        'aria-busy',
        'required',
      ],
    });
    signal?.addEventListener(
      'abort',
      () => {
        observer.disconnect();
        close();
      },
      { once: true },
    );
    updates.push(sync);
    sync();
  }
  // Programmatic .value assignments do not emit events or attribute mutations.
  return () => {
    for (const update of updates) update();
  };
}
