import type { Db } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import { helsinkiToUtc } from "../time.js";
import { addMessage, createConversation } from "./conversations.js";
import { createCarousel } from "./carousels.js";
import { createInboxItem } from "./inbox.js";
import { writeMemory } from "./memory.js";
import { createIdea, moveIntoPlan, todayHelsinki, weekDays } from "./plan.js";
import { createVideoJob } from "./video.js";

/**
 * The prototype's sample week, so Sabah can see every screen working before her own
 * content exists. Every row is flagged `sample`: it shows a "Sample" tag and the
 * publishing worker never touches it. "Remove sample content" deletes all of it.
 */
export async function loadSample(db: Db) {
  await removeSample(db);
  await withTransaction(db, async (c) => {
    const d = weekDays(todayHelsinki()); // Mon..Sun this week
    const cx = c;
    const i1 = await createIdea(cx, { title: "The one-sentence homepage", story: "Why we removed almost everything from the homepage, and what we gave up.", audience: "Founders and designers", purpose: "Show how Soma makes decisions", format: "Carousel", platforms: ["Instagram", "Facebook", "TikTok", "LinkedIn"] }, "sagal", true);
    const i2 = await createIdea(cx, { title: "Why one sentence", story: "Sabah explains the decision in 38 seconds, in her own recorded voice, through her HeyGen avatar.", audience: "Followers who like process", purpose: "Put a human voice to the work", format: "Avatar video", platforms: ["Instagram", "TikTok", "YouTube Shorts", "LinkedIn"] }, "sagal", true);
    const i3 = await createIdea(cx, { title: "Signs we keep photographing", story: "Hand-painted shopfront lettering from Somali-owned shops, credited, and what each one teaches about hierarchy.", audience: "Diaspora followers, type lovers", purpose: "Connect heritage and craft", format: "Carousel", platforms: ["Instagram"] }, "sagal", true);
    await createIdea(cx, { title: "The five-second test", story: "We show someone a page for five seconds and ask what it said. A method anyone can reuse.", audience: "Small business owners", purpose: "Teach something useful", format: "Short video", platforms: ["TikTok", "YouTube Shorts"] }, "sagal", true);
    await createIdea(cx, { title: "The drafts that lost", story: "The two homepage sentences that did not make it, and exactly why.", audience: "Designers", purpose: "Show taste through what we reject", format: "Single image", platforms: ["Instagram", "Facebook"] }, "sagal", true);
    const i6 = await createIdea(cx, { title: "Subway-sign calm", story: 'What public service notices get right about delivering bad news, applied to our "what changed" posts.', audience: "Founders", purpose: "Tone of voice, shown not told", format: "Single image", platforms: ["Instagram"] }, "sagal", true);

    const captions = {
      Instagram: "We cut our homepage down to one sentence.\n\nHere's how we decided what stayed, what moved one click deeper, and the two drafts that didn't make it.\n\nWhat would yours say?",
      Facebook: "We rewrote our homepage to a single sentence. This carousel walks through the decision: the question we asked, the drafts, and what we gave up.",
      TikTok: "three drafts, one survived. what would your homepage say in one sentence?",
      "YouTube Shorts": "Three drafts. One survived. #Shorts",
      LinkedIn: "We cut our homepage down to one sentence.\n\nThe question we asked, the drafts that lost, and what we gave up. Seven pages, two minutes.",
    };
    const carouselId = await createCarousel(cx, {
      title: "The one-sentence homepage", project: "Homepage story", ideaId: i1.id, captions,
      slides: [
        { role: "Hook", kicker: "A design decision", head: "We cut our homepage down to one sentence.", body: "", visual: "", theme: "ink" },
        { role: "Context", kicker: "Before", head: "The old page tried to explain everything at once.", body: "Four sections, three buttons, one very tired visitor.", visual: "Screenshot: previous homepage", theme: "paper" },
        { role: "Question", kicker: "The question", head: "What does someone need to know in the first five seconds?", body: "", visual: "", theme: "blue" },
        { role: "Process", kicker: "Drafts", head: "Three drafts. One survived.", body: "1 — too clever\n2 — too long\n3 — clear enough to say out loud", visual: "", theme: "soft" },
        { role: "Decision", kicker: "What we kept", head: "One sentence, one button, a lot of white space.", body: "", visual: "Screenshot: new homepage (needs Sabah)", theme: "paper" },
        { role: "Trade-off", kicker: "What we gave up", head: "Some detail moved one click deeper. We think that is fair.", body: "", visual: "", theme: "soft" },
        { role: "Close", kicker: "Your turn", head: "What would your homepage say in one sentence?", body: "Tell us in the comments.", visual: "", theme: "ink" },
      ],
    }, true);
    await c.query("UPDATE sagal.carousels SET draft = 2 WHERE id = $1", [carouselId]);
    await c.query(
      `INSERT INTO sagal.slide_comments (carousel_id, slide_index, who, text) VALUES
       ($1, 2, 'sabah', 'Fine, but make the question plainer.'),
       ($1, 2, 'sagal', 'Done. Swapped "above the fold" for "first five seconds".'),
       ($1, 4, 'sagal', 'Needs a real screenshot from you. The mock-up version feels like cheating.')`,
      [carouselId],
    );
    const videoId = await createVideoJob(cx, {
      title: "Why one sentence", ideaId: i2.id, dueAt: helsinkiToUtc(d[3], "12:00"),
      script: [
        { t: "0:00", part: "Hook", line: "We cut our homepage down to one sentence." },
        { t: "0:04", part: "Why", line: "The old page tried to explain everything at once, so it explained nothing." },
        { t: "0:14", part: "How", line: "We asked one question: what does someone need to know in the first five seconds?" },
        { t: "0:26", part: "Trade-off", line: "Some detail moved one click deeper. We think that is fair." },
        { t: "0:34", part: "Close", line: "What would yours say?" },
      ],
      platformCaptions: {
        Instagram: "Why we cut our homepage to one sentence, in my own words.",
        TikTok: "why we cut our homepage to one sentence",
        "YouTube Shorts": "Why we cut our homepage to one sentence #Shorts",
        LinkedIn: "We cut our homepage to one sentence. Here's the decision in 38 seconds.",
      },
    }, true);
    await c.query("UPDATE sagal.video_jobs SET script_status = 'Final · approved Mon' WHERE id = $1", [videoId]);

    await moveIntoPlan(cx, i1.id, d[0], "09:30");
    await moveIntoPlan(cx, i2.id, d[3], "12:30");
    await moveIntoPlan(cx, i6.id, d[4], "16:00");
    // Show every status the calendar can have (all clearly marked sample).
    const set = (title: string, platform: string, status: string, note: string) =>
      c.query("UPDATE sagal.posts SET status = $3, note = $4 WHERE sample AND title = $1 AND platform = $2", [title, platform, status, note]);
    await set("The one-sentence homepage", "Instagram", "confirmed", "Instagram confirmed the post (sample).");
    await set("The one-sentence homepage", "TikTok", "failed", "TikTok rejected the login (sample). Nothing was posted. Reconnect TikTok and Sagal retries at the next agreed slot.");
    await set("The one-sentence homepage", "Facebook", "publishing", "Sent to Facebook. Waiting for Facebook to confirm (sample).");
    await c.query("UPDATE sagal.posts SET scheduled_at = $1 WHERE sample AND title = 'The one-sentence homepage' AND platform = 'Facebook'", [helsinkiToUtc(d[2], "18:00")]);
    await c.query("UPDATE sagal.posts SET scheduled_at = $1 WHERE sample AND title = 'The one-sentence homepage' AND platform = 'LinkedIn'", [helsinkiToUtc(d[3], "08:30")]);
    await c.query("UPDATE sagal.posts SET scheduled_at = $1 WHERE sample AND title = 'The one-sentence homepage' AND platform = 'TikTok'", [helsinkiToUtc(d[1], "12:00")]);

    const conv = await createConversation(cx, "Homepage story", "One-sentence carousel", true);
    await addMessage(cx, conv, { sender: "sabah", text: "Can we turn the homepage rewrite into a carousel? Keep it honest. No big claims." });
    await addMessage(cx, conv, { sender: "sagal", text: "Yes. And I love that it's a story about removing things, which is secretly the hardest kind of design story to tell. First draft is on the right: seven slides, one idea each.", card: { type: "carousel", id: carouselId, title: "The one-sentence homepage", sub: "7 slides · 4:5 · draft 2" } });
    await addMessage(cx, conv, { sender: "sagal", text: "Two things I'm overthinking, constructively. Slide 3 might be too clever. Slide 5 needs a real screenshot from you. Everything else I can handle." });
    await addMessage(cx, conv, { sender: "sabah", text: "Slide three is fine, but make the question plainer. I'll send the screenshot tonight.", context: { type: "slide", id: `${carouselId}:2`, label: "Slide 3 · The question" } });
    await addMessage(cx, conv, { sender: "sagal", text: "Plainer it is. Does this sound like you?", quote: "What does someone need to know in the first five seconds?", decision: { options: ["Use this", "Keep the original", "Try another"], picked: null } });
    const conv2 = await createConversation(cx, "Diaspora type series", "Shopfront lettering idea", true);
    await addMessage(cx, conv2, { sender: "sabah", text: "I keep photographing hand-painted shopfront signs from Somali-owned shops. Is there something in that?" });
    await addMessage(cx, conv2, { sender: "sagal", text: "There's a lot in that. Every one of them solves hierarchy with almost nothing: a name, what they sell, a phone number. I sketched it on the right. We'd credit the shops, show the lettering, and pull out one lesson per slide.", card: { type: "idea", id: i3.id, title: "Signs we keep photographing", sub: "Idea · Carousel · Instagram" } });

    const item = (x: Parameters<typeof createInboxItem>[1]) => createInboxItem(c, { ...x, sample: true });
    await item({ kind: "Missing audio", dueLabel: "Needed by Thu 12:00", urgent: true, title: "Your voiceover for “Why one sentence”", body: "The script is final and HeyGen is ready. I only need your 38-second voiceover. Record it somewhere quiet; your phone is fine.", primaryLabel: "Upload voiceover", primaryAction: "go:video" });
    await item({ kind: "Decision", dueLabel: "Before Thu", title: "Which screenshot for slide 5?", body: "I have the live homepage and the Figma version. The live one is more honest. The Figma one is cleaner. I'd pick live.", primaryLabel: "Use the live one", secondaryLabel: "Use Figma" });
    await item({ kind: "Outside the plan", dueLabel: "Today", title: "Swap Thursday and Friday?", body: "People are talking about homepage redesigns this week. I'd like to move Friday's reference post to Thursday while it's relevant. That changes the plan you approved, so it's your call.", primaryLabel: "Approve the swap", secondaryLabel: "Keep the plan" });
    await item({ kind: "Production problem", dueLabel: "Not urgent", title: "Captions is disconnected", body: "I can't send the edit to Captions. I've packaged everything so you can drop it in by hand. About two minutes.", primaryLabel: "Open manual handoff", primaryAction: "go:video" });

    const insp = [
      ["Brooklyn / New York", "Hand-lettered bodega awning", "Street photo · add source link", "Three sizes of type do all the work: the name, what they sell, the phone number. Nothing else competes.", "Rebuild one Soma page using only three type sizes, and show the before and after.", false],
      ["Somali / diaspora", "Family wedding programme, 1990s", "From Sabah's archive · private, don't post", "Somali and English set side by side. Neither is treated as the translation.", "A bilingual post where both languages carry equal typographic weight.", true],
      ["Brooklyn / New York", "Subway service-change posters", "Public signage · add source link", "Bad news in calm, plain language, with exactly one thing to do next.", 'Use the same tone for our "what we changed" posts.', false],
      ["Somali / diaspora", "Guntiino and dirac fabric repeats", "Museum collection · add source link", "Bold repeats with a lot of air between them. The pattern frames rather than fills.", "A slide system where pattern sits at the edges and text keeps the centre.", false],
      ["Somali / diaspora", "Buraanbur call and response", "Performance recording · add source link", "The audience finishes the line. The form expects participation.", "End a carousel on an open line for followers to complete.", false],
      ["Brooklyn / New York", "Laundromat price boards", "Street photo · add source link", "Prices first, everything else second. You can read it from across the street.", 'A "what it costs to work with us" post with the same bluntness.', false],
    ] as const;
    for (const r of insp) {
      await c.query("INSERT INTO sagal.inspiration (category, title, source, noticed, idea, private, sample) VALUES ($1,$2,$3,$4,$5,$6,true)", [...r]);
    }
    await c.query(
      `INSERT INTO sagal.lessons (kicker, title, evidence, sample) VALUES
       ('Lesson 1', 'Showing rejected work got more saves than showing finished work.', 'Evidence: 3 of the last 4 process posts (sample)', true),
       ('Lesson 2', 'Plain first slides beat clever ones.', 'Evidence: swipe-through on 2 carousels (sample)', true),
       ('Still guessing', 'Your voice vs. text-only videos. Not enough posts to say yet.', 'Sagal will say when there''s enough to tell', true)`,
    );
    await c.query(
      `INSERT INTO shared.tasks (type, title, status, owner, evidence, next_step, created_by, sample) VALUES
       ('Brief from Bilan', 'Process-led carousel for a paid test', 'In progress', 'Sagal', 'Bilan brief · audience: founders in Finland', 'Sagal delivers 4:5 and 9:16 by Fri', 'bilan', true),
       ('Asset prepared', '4:5 and 9:16 cuts of “The one-sentence homepage”', 'Ready for Bilan', 'Sagal → Bilan', '2 exports · text-safe areas checked', 'Bilan reviews', 'sagal', true),
       ('Proposed for paid', '“Three drafts. One survived.” (organic, Mon)', 'Needs Sabah', 'Sabah decides', 'Saved 2.1× the account median (sample data)', 'Approve before Sagal sends it to Bilan', 'sagal', true),
       ('Brief from Bilan', '15-second cut with burned-in captions', 'Blocked', 'Sagal', 'Waiting for Sabah''s voiceover', 'Unblocks when the voiceover arrives', 'bilan', true),
       ('Proposed for paid', 'Subway-sign calm (single image)', 'Declined', 'Bilan', 'Bilan: “Too early. No organic signal yet.”', 'Revisit after Friday', 'bilan', true)`,
    );
    const facts: [string, string][] = [["name", "Soma"], ["where", "Helsinki, Finland"], ["tz", "Europe/Helsinki"], ["lang", "English, Somali"], ["aud", "Founders, designers, Somali diaspora"]];
    for (const [k, v] of facts) {
      const exists = await c.query("SELECT 1 FROM shared.memory_entries WHERE section = 'facts' AND key = $1", [k]);
      if (!exists.rowCount) await writeMemory(c, "facts", k, v, "sabah", { sample: true });
    }
    const lang = [
      ["what-we-changed", { say: "Here's what we changed, and why.", not: "We're thrilled to unveil our new look!" }],
      ["fair", { say: "We think that's fair.", not: "A total game-changer." }],
      ["somali-signoff", { say: "Mahadsanid.", note: "Used on bilingual posts. Checked by Sabah." }],
    ] as const;
    for (const [k, v] of lang) await writeMemory(c, "language", `sample-${k}`, v, "sabah", { sample: true });
    const prefs = ["Plain words, no hype", "Show the work, not the result", "One idea per slide", "Credit every reference", "No invented client results", "Blue as accent only", "Avoid: New York clichés"];
    for (const [i, p] of prefs.entries()) await writeMemory(c, "preferences", `sample-${i}`, p, "sabah", { sample: true });
  });
}

export async function removeSample(db: Db) {
  await withTransaction(db, async (c) => {
    await c.query("DELETE FROM sagal.posts WHERE sample");
    await c.query("DELETE FROM sagal.carousels WHERE sample");
    await c.query("DELETE FROM sagal.video_jobs WHERE sample");
    await c.query("DELETE FROM sagal.ideas WHERE sample");
    await c.query("DELETE FROM sagal.conversations WHERE sample");
    await c.query("DELETE FROM sagal.projects p WHERE name <> 'Unsorted' AND NOT EXISTS (SELECT 1 FROM sagal.conversations c WHERE c.project_id = p.id)");
    await c.query("DELETE FROM sagal.inbox_items WHERE sample");
    await c.query("DELETE FROM sagal.inspiration WHERE sample");
    await c.query("DELETE FROM sagal.lessons WHERE sample");
    await c.query("DELETE FROM shared.tasks WHERE sample");
    await c.query("DELETE FROM shared.memory_entries WHERE sample");
  });
}

export async function hasSample(db: Db): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM sagal.ideas WHERE sample LIMIT 1");
  return Boolean(rowCount);
}
