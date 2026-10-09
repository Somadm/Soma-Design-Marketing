/**
 * Asturan theme extras: related-product loading, the size guide dialog and the
 * "Complete the look" one-click add. Each part works without the others.
 */

/* Related products: fetch the recommendations section once it nears the viewport. */
function loadRecommendations(container) {
  const url = container.dataset.url;
  if (!url) return;

  fetch(url)
    .then((response) => response.text())
    .then((text) => {
      const html = new DOMParser().parseFromString(text, 'text/html');
      const fresh = html.querySelector('.asturan-related .asturan-container');
      if (fresh && fresh.innerHTML.trim()) {
        container.innerHTML = fresh.innerHTML;
        container.removeAttribute('data-url');
      }
    })
    .catch(() => {});
}

function initRecommendations() {
  const containers = document.querySelectorAll('[data-asturan-recommendations][data-url]');
  if (!containers.length) return;

  if (!('IntersectionObserver' in window)) {
    containers.forEach(loadRecommendations);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadRecommendations(/** @type {HTMLElement} */ (entry.target));
      });
    },
    { rootMargin: '0px 0px 400px 0px' },
  );
  containers.forEach((container) => observer.observe(container));
}

/* Size guide and other dialogs opened with [data-asturan-dialog-open]. */
document.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const opener = target.closest('[data-asturan-dialog-open]');
  if (opener) {
    const dialog = document.getElementById(opener.getAttribute('data-asturan-dialog-open') || '');
    if (dialog instanceof HTMLDialogElement && typeof dialog.showModal === 'function') {
      event.preventDefault();
      dialog.showModal();
    }
    return;
  }

  if (target.closest('[data-asturan-dialog-close]')) {
    target.closest('dialog')?.close();
    return;
  }

  // Close when the backdrop (the dialog element itself) is clicked.
  if (target instanceof HTMLDialogElement && target.classList.contains('asturan-dialog')) {
    target.close();
  }
});

/* Complete the look: keep the price in step with the chosen variant. */
document.addEventListener('change', (event) => {
  const select = /** @type {HTMLElement} */ (event.target);
  if (!(select instanceof HTMLSelectElement) || !select.classList.contains('asturan-ctl__select')) return;
  const price = select.selectedOptions[0]?.dataset.price;
  const priceEl = select.closest('.asturan-ctl__info')?.querySelector('[data-asturan-ctl-price]');
  if (price && priceEl) priceEl.textContent = price;
});

/**
 * Complete the look: add to cart without leaving the page. Uses the same cart event as Horizon's
 * product form so the cart drawer and cart count update. Without JavaScript the form posts normally.
 */
document.addEventListener('submit', async (event) => {
  const form = /** @type {HTMLFormElement} */ (event.target);
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-asturan-quick-add')) return;
  event.preventDefault();

  const button = form.querySelector('button[type="submit"]');
  const status = form.parentElement?.querySelector('.asturan-ctl__status');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;

  const originalLabel = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (status) status.textContent = '';

  const formData = new FormData(form);
  const sectionIds = Array.from(document.querySelectorAll('cart-items-component'))
    .map((element) => /** @type {HTMLElement} */ (element).dataset.sectionId)
    .filter(Boolean);
  if (sectionIds.length) formData.append('sections', sectionIds.join(','));

  /** @type {any} */
  let CartEvent = null;
  /** @type {any} */
  let deferred = null;
  try {
    ({ CartLinesUpdateEvent: CartEvent } = await import('@shopify/events'));
    deferred = CartEvent.createPromise();
    form.dispatchEvent(
      new CartEvent({
        action: 'add',
        context: 'product',
        lines: [{ merchandiseId: String(formData.get('id')), quantity: 1 }],
        promise: deferred.promise,
      }),
    );
  } catch (error) {
    CartEvent = null;
  }

  const routes = /** @type {any} */ (window).Theme?.routes || {};
  const addUrl = routes.cart_add_url || '/cart/add.js';
  const cartUrl = `${routes.cart_url || '/cart'}.js`;

  let reachedServer = false;
  try {
    const response = await fetch(addUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: formData,
    });
    reachedServer = true;
    const result = await response.json();
    const cart = await fetch(cartUrl, { headers: { Accept: 'application/json' } }).then((r) => r.json());

    if (!response.ok || result.status) {
      deferred?.resolve({
        cart: CartEvent.createCartFromAjaxResponse(cart),
        detail: {
          didError: true,
          items: cart.items,
          source: 'asturan-complete-the-look',
          sourceId: form.id,
          itemCount: 1,
        },
      });
      if (status) status.textContent = result.description || result.message || '';
      button.textContent = originalLabel;
    } else {
      deferred?.resolve({
        cart: CartEvent.createCartFromAjaxResponse(cart),
        detail: {
          didError: false,
          items: cart.items,
          sections: result.sections,
          source: 'asturan-complete-the-look',
          sourceId: form.id,
          itemCount: 1,
          productId: String(result.product_id || ''),
        },
      });
      button.textContent = button.dataset.labelAdded || originalLabel;
      if (status) status.textContent = button.dataset.labelAdded || '';
      window.setTimeout(() => {
        button.textContent = originalLabel;
        if (status) status.textContent = '';
      }, 2500);
    }
  } catch (error) {
    deferred?.reject?.(error);
    // Only fall back to a normal form post when the item was not added, so it is never added twice.
    if (!reachedServer) form.submit();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRecommendations);
} else {
  initRecommendations();
}
document.addEventListener('shopify:section:load', initRecommendations);

/**
 * Buy it now: add the variant and quantity chosen in the product form, then go to checkout.
 * The variant id input is kept up to date by Horizon's variant picker.
 */
document.addEventListener('click', async (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('[data-asturan-buy-now]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;

  const scope = button.closest('.shopify-section') || document;
  const productForm = scope.querySelector('form[data-type="add-to-cart-form"]');
  const idInput = productForm?.querySelector('input[name="id"]');
  const variantId = idInput instanceof HTMLInputElement ? idInput.value : null;
  const quantityInput = productForm?.querySelector('input[name="quantity"]');
  const quantity = Math.max(1, Number(quantityInput instanceof HTMLInputElement ? quantityInput.value : 1) || 1);
  const status = button.parentElement?.querySelector('.asturan-buy-now__status');
  if (!variantId) return;

  const addButton = productForm?.querySelector('button[type="submit"], .add-to-cart-button');
  if (addButton instanceof HTMLButtonElement && addButton.disabled) return;

  const routes = /** @type {any} */ (window).Theme?.routes || {};
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (status) status.textContent = '';

  try {
    const response = await fetch(routes.cart_add_url || '/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: [{ id: Number(variantId), quantity }] }),
    });
    const result = await response.json();
    if (!response.ok || result.status) {
      if (status) status.textContent = result.description || result.message || '';
      return;
    }
    window.location.href = button.dataset.checkoutUrl || '/checkout';
  } catch (error) {
    window.location.href = button.dataset.checkoutUrl || '/checkout';
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});

/* Product page accordion: keep one section open at a time. */
document.addEventListener(
  'toggle',
  (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.open) return;
    const accordion = details.closest('.product-details .accordion');
    if (!accordion) return;
    accordion.querySelectorAll('details[open]').forEach((other) => {
      if (other !== details) other.open = false;
    });
  },
  true,
);

/* Hero banners: cross-fade every few seconds, pause on hover or focus, dots to jump. */
function initSlideshows() {
  document.querySelectorAll('[data-asturan-slideshow]').forEach((root) => {
    if (!(root instanceof HTMLElement) || root.dataset.ready) return;
    root.dataset.ready = 'true';

    const slides = Array.from(root.querySelectorAll('.asturan-slide'));
    const dots = Array.from(root.querySelectorAll('[data-asturan-slide-to]'));
    if (slides.length < 2) return;

    let index = 0;
    let timer = 0;
    const interval = Math.max(3000, Number(root.dataset.interval) || 5000);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const show = (next) => {
      index = (next + slides.length) % slides.length;
      slides.forEach((slide, i) => {
        const active = i === index;
        slide.classList.toggle('is-active', active);
        if (active) {
          slide.removeAttribute('aria-hidden');
          slide.removeAttribute('tabindex');
          slide.querySelectorAll('img[loading="lazy"]').forEach((img) => img.setAttribute('loading', 'eager'));
        } else {
          slide.setAttribute('aria-hidden', 'true');
          slide.setAttribute('tabindex', '-1');
        }
      });
      dots.forEach((dot, i) => dot.setAttribute('aria-current', String(i === index)));
      // Load the following banner ahead of time so the fade never shows an empty frame.
      slides[(index + 1) % slides.length]
        .querySelectorAll('img[loading="lazy"]')
        .forEach((img) => img.setAttribute('loading', 'eager'));
    };

    const stop = () => window.clearInterval(timer);
    const start = () => {
      stop();
      if (!reduceMotion) timer = window.setInterval(() => show(index + 1), interval);
    };

    dots.forEach((dot) =>
      dot.addEventListener('click', () => {
        show(Number(dot.getAttribute('data-asturan-slide-to')) || 0);
        start();
      }),
    );
    root.addEventListener('mouseenter', stop);
    root.addEventListener('mouseleave', start);
    root.addEventListener('focusin', stop);
    root.addEventListener('focusout', start);
    show(0);
    start();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSlideshows);
} else {
  initSlideshows();
}
document.addEventListener('shopify:section:load', initSlideshows);

/* Category bar dropdowns: hover on desktop, click or tap on the arrow, Escape or an outside click to close. */
function setDropdown(dropdown, open) {
  if (open) dropdown.setAttribute('data-open', '');
  else dropdown.removeAttribute('data-open');
  dropdown.querySelector('.asturan-dd__toggle')?.setAttribute('aria-expanded', String(open));
}

document.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const toggle = target.closest('.asturan-dd__toggle');
  document.querySelectorAll('[data-asturan-dd][data-open]').forEach((dropdown) => {
    if (!dropdown.contains(target)) setDropdown(dropdown, false);
  });
  if (!toggle) return;
  const dropdown = toggle.closest('[data-asturan-dd]');
  if (dropdown) setDropdown(dropdown, !dropdown.hasAttribute('data-open'));
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('[data-asturan-dd][data-open]').forEach((dropdown) => {
    setDropdown(dropdown, false);
    dropdown.querySelector('.asturan-dd__toggle')?.focus();
  });
});

document.addEventListener('mouseover', (event) => {
  const dropdown = /** @type {HTMLElement} */ (event.target).closest?.('[data-asturan-dd]');
  document.querySelectorAll('[data-asturan-dd]').forEach((item) => {
    const toggle = item.querySelector('.asturan-dd__toggle');
    if (!item.hasAttribute('data-open')) toggle?.setAttribute('aria-expanded', String(item === dropdown));
  });
});
