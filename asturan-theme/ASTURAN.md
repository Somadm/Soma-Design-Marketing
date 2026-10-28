# Asturan Modest Wear — theme redesign

Shopify **Horizon 4.2.0** (Shopify's free theme) with an Asturan brand layer on top. All Horizon
code is unchanged, apart from one line in `layout/theme.liquid` that loads the brand layer. That
keeps future Horizon updates easy to merge. Products, collections, prices and descriptions all come
from the live store. Everything below can be edited in **Online Store → Themes → Customize**.

## Install (unpublished)

Pick one. None of them publishes the theme:

- **Upload:** zip the contents of this folder (`assets/`, `blocks/`, `config/` and the other folders
  at the top level of the zip), then go to Online Store → Themes → Add theme → Upload zip file.
- **Shopify CLI:** `shopify theme push --path asturan-theme --unpublished --store <store>.myshopify.com`
- **Preview with live data while editing:** `shopify theme dev --path asturan-theme --store <store>.myshopify.com`

Publish only after approval: Themes → … → Publish.

## Design

The look follows the Asturan brand presentation: Asturan Burgundy (#7E252A) as the main colour, gold
accents, warm white sections, solid burgundy and black panels, square photo frames, large serif headlines
(Noto Serif) and small bold letter-spaced labels (Noto Sans). Cormorant Garamond + Jost is one switch away
in Theme settings → Asturan brand.

**Logo:** the final logo is built in (`assets/asturan-logo.png`, white version `asturan-logo-white.png`
in the footer), centred at the top at 140px tall on desktop and 64px on mobile. Change the size under
Theme settings → Asturan brand. Uploading a logo under Logo and favicon replaces the built-in one.

**Header:** burgundy background with the gold logo (Theme settings → Asturan brand → Logo colour), and a
burgundy category bar under it (gold group names, white links, white Sale button). The category bar can be
switched back to white in its section settings.

**Hero banners:** the four Asturan campaign banners are included in the theme and rotate every 5 seconds,
shown whole (never cropped), each linking to its collection. To use other banners, add Banner blocks to
the hero in Customize (desktop and optional mobile image plus a link). For sharper banners on large
screens, upload the original full-size files as Banner blocks.

**Nothing left empty:** every image spot fills itself from the store's own products when no image is
chosen: category tiles use the collection's first product, "Who we are" and the feature panel use
collection or store product photos, Trending falls back to the newest products, and Shop the look uses
the first product whose name contains "Metallic Satin" (then the first Open Abaya).

**Print dropdown:** under Hijabs → Print, a dropdown lists All Print Hijabs, Premium Printed Modal Hijab
and Premium Jersey Hijab (category bar → Dropdown item blocks). Each item links to the product with that
handle, or to a store search for its name if the handle differs. On mobile they appear as their own buttons.

**The Hijab Edit:** the last hero slide is a burgundy text slide ("The Hijab Edit", "Chiffon, viscose and
print hijabs, from $5.99.", Shop Hijabs and Print Hijabs) with three hijab photos included in the theme
(`assets/asturan-hijab-1..3.jpg`). Edit its text, links and photos in Customize → Hero → The Hijab Edit
slide. Slides change every 6 seconds.

**Favicon:** the gold A mark on burgundy (`assets/asturan-favicon.png`, 512×512) is used until a favicon is
uploaded under Theme settings → Logo and favicon.

**Hijab fabrics:** the Print dropdown lists Premium Printed Modal Hijab, Premium Jersey Hijab and Twill Modal
Hijab.

**Categories on the landing page:** every category is visible on the homepage without opening a menu:
in the category bar under the logo (a scrollable button row on mobile), and in the 8 category tiles
directly below the hero.

## What's new

| Where | File | What it does |
| --- | --- | --- |
| Theme settings → Asturan brand | `config/settings_schema.json` | Burgundy and gold, brand fonts on or off, size guide page, colour option names |
| Every page | `snippets/asturan-brand.liquid`, `assets/asturan.css`, `assets/asturan.js` | Brand colours, Cormorant Garamond and Jost, all Asturan styles |
| Header | `sections/header-group.json` | Burgundy announcement bar, centred logo |
| Header | `sections/asturan-category-bar.liquid` | Every category visible: desktop bar (group names in burgundy, Sale as a burgundy button) and a scrollable button row on mobile ending in Sale |
| Home | `sections/asturan-hero.liquid` | Full-width campaign image, "Summer Favorites.", "Home of *Modest* fashion.", Shop Abayas and Shop Hijabs |
| Home | `sections/asturan-category-tiles.liquid` | 8 arched tiles with burgundy group labels; Sale tile solid burgundy |
| Home | `sections/asturan-trending.liquid` | Trending Products with colour dots, name, price and View all |
| Home | `sections/asturan-shop-the-look.liquid` | Burgundy block: large photo, name, price, colours, sizes, white Shop now button |
| Home | `sections/asturan-brand-intro.liquid` | "Who we are": burgundy headline, text, gold tagline and two overlapping photos |
| Home | `sections/asturan-feature-panel.liquid` | Photos next to a burgundy or black panel (for example "Soft neutrals. Strong basics." for hijabs) |
| Home | `sections/asturan-promises.liquid` | 4 store promises as warm cards with gold top lines |
| Footer | `sections/asturan-footer.liquid` | Burgundy footer: email sign-up, Shop and Help menus, contact email, Instagram and TikTok (@shop.asturan) |
| Product | `templates/product.json` | Gallery with thumbnails (swipeable on mobile), category label, name, price, round swatches with the selected colour name, sizes 52–62 (selected size burgundy), size guide, quantity, burgundy Add to cart, outlined Buy it now, promise line, Complete the look, Description / Size & fit / Shipping & returns, You may also like |
| Product | `blocks/asturan-*.liquid` | Category label, size guide, promise line, product info, Complete the look (one-click Add) |
| Product | `sections/asturan-related-products.liquid` | 4 related products; horizontal scroll on mobile |
| Mobile | Horizon's sticky add-to-cart (turned on) | Bar pinned to the bottom with the price and the selected colour and size |

Buttons and tap targets are at least 44px tall. Category tiles and product grids show 2 per row on
mobile.

## To do in the store admin before approval

These are store data, not theme code, so they can't be done from this repository:

1. **Collections:** the theme points at these collection handles: `abayas`, `open-abayas`,
   `closed-abayas`, `crepe-abayas`, `hijabs`, `chiffon-hijabs`, `print-hijabs`, `prayer-sets`,
   `new-trending` and `sale`. In the customizer, check the category bar, the tiles and the
   Trending section. Re-pick any collection whose handle is different in the store. A tile or
   link without a collection falls back to "All products", and its label still shows.
2. **Photos:** add the campaign image (hero) and tall photos for the 8 tiles. The Shop the look block uses the product's own
   photo unless you choose one, so the placeholder logo images are gone.
3. **Shop the look:** pick the product in the customizer (Home → Asturan shop the look → Look).
   The "Shop now" button links to that product. The old "View Details" buttons that linked
   nowhere are not used any more.
4. **Brown Metallic Satin Open Abaya Set:** in Products, add its missing photo. Under "Search
   engine listing", change the URL handle from `red-metallic-satin-open-abaya-copy` to
   `brown-metallic-satin-open-abaya-set` and keep "Create a URL redirect" ticked.
5. **Colour swatches:** round swatches need colours on the product's Color option (Products →
   product → Color option → set each value's swatch, or link the option to the Color category
   metafield). Without them, colours show as buttons.
6. **Size guide:** create a page (e.g. "Size guide") and choose it in Theme settings → Asturan brand.
7. **Complete the look:** by default it shows the first available product in Chiffon Hijabs. To
   match a specific hijab to each abaya, create a product metafield `custom.complete_the_look`
   (type: Product) and fill it in on each abaya.
8. **Copy:** the Size & fit and Shipping & returns text, and the promise descriptions, are short
   placeholders. Paste the current site's wording. Products with a `custom.size_fit` or
   `custom.shipping_returns` metafield show their own text instead.
9. **Social links:** the footer links to instagram.com/shop.asturan and tiktok.com/@shop.asturan.
   Check both in the footer settings.
10. **Fonts:** brand fonts load from Google Fonts. To use Shopify-hosted fonts instead, untick
    "Use brand fonts" and pick Cormorant Garamond and Jost under Typography (if they're in
    Shopify's font library).

## Editorial hero (v7)

`sections/asturan-editorial-hero.liquid` is now the first homepage section: light background, oversized
serif headline ("Modest style. / *Beautifully yours.*"), small label and text, arrow-style links
(SHOP HIJABS → `hijabs`, SHOP ABAYAS → `abayas`), a large model portrait overlapping a smaller lifestyle
photo, soft blush and gold shapes, and a CSS-only entrance animation that is off for reduced-motion
visitors. Text, links and both photos are editable (Customize → Asturan editorial hero); the included
Asturan photos are used until others are chosen. The previous banner slideshow is still in the homepage
template, switched off ("Asturan hero" → show section to restore it).

## Welcome pop-up (v7)

`sections/asturan-popup.liquid` (footer group, so it can appear on every page).

- **Sign-up:** Shopify's own customer form. Each sign-up is saved in Shopify admin → Customers with email
  marketing consent and the tags `newsletter` and `welcome-offer`. Works with Shopify's spam protection.
- **When it shows:** after 8 seconds, not on cart/checkout/account pages, not to signed-in customers who
  already subscribe or have ordered. Closing it hides it for 7 days; after signing up it never shows again
  on that browser. All adjustable in the section settings.
- **States:** inline email validation, "Sending…" while submitting, server errors shown in the pop-up,
  success screen with the code, a copy button, and a "Start shopping" button that applies the code
  through `/discount/WELCOME10` so it is already in place at checkout.
- **Accessibility:** native modal dialog with labelled heading and text, focus moves into the pop-up and
  returns afterwards, Escape and the 44px close button close it, consent text links to the privacy policy.

### Store setup still needed (Shopify admin)

1. **Create the code** (Discounts → Create discount → Amount off order):
   code `WELCOME10`, 10%, no minimum, *Eligibility*: specific customer segment
   `customer_tags CONTAINS 'welcome-offer' AND number_of_orders = 0`, *Maximum discount uses*: limit to
   one use per customer, no end date. The code name must match the pop-up setting "Welcome discount code".
2. **Welcome email:** Shopify Email → Automations → *Welcome new subscribers* → add the code and the free
   hijab note → turn on. (If another email platform is used, set up the same welcome email there.)
3. **Free hijab:** the code is the only thing customers need. To fulfil, filter Orders by discount code
   `WELCOME10` and pack a hijab; optionally a free Shopify Flow workflow can tag those orders
   `welcome-gift` automatically.

## Sliding editorial hero (v8)

The editorial hero now slides like an editorial lookbook: four Panel blocks glide sideways every 5 seconds
with a layered parallax movement (text, photos and soft shapes travel at slightly different speeds), and
after the last panel it rewinds to the first. Panels: *Modest style. / Beautifully yours.* (hijabs and
abayas), *Light as air. / Made to drape.* (hijab edit), *Metallic satin. / Made to be seen.* (open
abayas), *Pray in comfort. / Dressed in grace.* (prayer sets). Photos alternate left and right.

Controls: 01 ─ 04 progress, previous and next arrows, pause/play, swipe on phones, arrow keys. Keyboard
focus holds the current panel; reduced-motion visitors get no gliding and no automatic sliding. Each
panel's text, links, layout and photos are editable (Customize → Asturan editorial hero → Panel); the
included Asturan photos are used until others are chosen. Timing: Customize → Sliding.
