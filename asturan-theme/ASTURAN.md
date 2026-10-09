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
