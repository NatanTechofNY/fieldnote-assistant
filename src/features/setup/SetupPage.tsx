import { Fragment, useState } from "react";
import { ArrowRight, Check, CheckCircle2 } from "lucide-react";
import { PageHead } from "../../components/layout/PageHead";
import { DoorMark, LoopMark, StoryArt } from "./SetupArt";

export function SetupPage() {
  const [activeStep, setActiveStep] = useState(0);
  const story = [
    {
      label: "Capture",
      title: "Start with a thought.",
      description: "Open the agent panel with ⌘I from any page, send a text, or add the assistant to an iMessage group chat. Twilio delivers SMS and Sendblue delivers iMessage, both through a verified webhook, and a picture someone sends is described so the assistant can answer it.",
      detail: "Your own chats share one memory; each group chat gets a thread of its own.",
      path: ["Web or text", "Conversation"],
    },
    {
      label: "Decide",
      title: "The assistant decides what to do.",
      description: "Agent Studio reads your request alongside your profile, your Soul, and the memories that bear on it, then searches your records or the web and calls a typed local tool to change something here or to read your Jira and Confluence.",
      detail: "It makes ordinary changes without asking and checks first before anything irreversible.",
      path: ["Agent Studio", "Search or tool"],
    },
    {
      label: "Commit",
      title: "Local data stays authoritative.",
      description: "The Node API validates each action and commits it to SQLite, filing anything asked for in a group chat under that group's own life area. A durable outbox records what must be synchronized next.",
      detail: "If search sync fails, your task or memory is still safely stored.",
      path: ["Node API", "SQLite + outbox"],
    },
    {
      label: "Recall",
      title: "Meaning becomes searchable.",
      description: "Algolia NeuralSearch indexes redacted copies of tasks, memories, and Web or SMS conversation text, blending keyword matching with semantic, vector-based retrieval. Every turn also carries the memories that bear on the message, so you never have to repeat yourself.",
      detail: "Phone numbers, tool payloads, and provider metadata stay in SQLite, and a group chat only ever searches its own records.",
      path: ["NeuralSearch", "Grounded recall"],
    },
  ] as const;
  const features = [
    {
      number: "01",
      mark: "plan",
      title: "Plan the work",
      description: "Todos, subtasks, and repeating routines that roll forward on their own, with reminders and daily digests by text and a follow-up the morning after something slips.",
      route: "Board · Today",
    },
    {
      number: "02",
      mark: "memory",
      title: "Build a memory",
      description: "Facts, notes, and journals stay canonical in SQLite and become searchable by meaning. The assistant keeps durable facts it notices in passing and rewrites a short profile of your life from them overnight.",
      route: "Memory · ⌘K search",
    },
    {
      number: "03",
      mark: "thread",
      title: "Remember the conversation",
      description: "Search across redacted Web, SMS, and group chat history, where each message keeps who said it, then open the canonical thread around any match.",
      route: "History · NeuralSearch",
    },
    {
      number: "04",
      mark: "window",
      title: "Reflect on any window",
      description: "Choose today, this week, this month, or a custom range and save a grounded Journal draft. An evening check-in turns your answer into the day's entry.",
      route: "Reflections · Journal",
    },
  ] as const;
  const doors = [
    {
      number: "01",
      tone: "danger",
      mark: "sms",
      brand: "Twilio",
      title: "Text with Twilio",
      description: "A signed webhook receives your text. A queued worker gives it to Agent Studio, runs any local tools, then sends the reply back by SMS.",
      route: ["Text", "Agent", "Reply"],
      note: "Also delivers reminders, daily digests, the evening check-in, and searchable conversation history.",
    },
    {
      number: "02",
      tone: "success",
      mark: "imessage",
      brand: "Sendblue",
      title: "iMessage with Sendblue",
      description: "The same conversation as a blue bubble. Sendblue marks your message read and starts typing the moment it lands, and the assistant can answer with a tapback or reply inside a thread, or send a picture. It falls back to RCS and SMS on its own if iMessage cannot carry it.",
      route: ["iMessage", "Agent", "Reply"],
      note: "Settings decides which provider sends, but a reply always goes back on the line the message arrived on.",
    },
    {
      number: "03",
      tone: "accent",
      mark: "group",
      brand: "iMessage groups",
      title: "Share it in a group chat",
      description: "Add the assistant's number to an iMessage group and the people you trust can ask it too. It knows who is in the room, stays quiet when a message is not for it, and can send a morning note and an evening question on a schedule.",
      route: ["Group", "Scope", "Reply"],
      note: "Each group gets its own life area, profile, and Soul, and a question asked there never reaches your own todos and memories.",
    },
    {
      number: "04",
      tone: "warn",
      mark: "notes",
      brand: "Granola",
      title: "Review from Granola",
      description: "The worker polls Granola’s read-only notes API, deduplicates updates, and waits for you to save or ignore each meeting.",
      route: ["Poll", "Review", "Memory"],
      note: "Nothing is saved as a memory without your review.",
    },
    {
      number: "05",
      tone: "info",
      mark: "board",
      brand: "Atlassian",
      title: "Read from Atlassian",
      description: "Read-only tools query Jira boards and issues and Confluence pages and comments. A brief you write in your own words runs on its own schedule and arrives as one text.",
      route: ["Pin", "Read", "Text"],
      note: "Pinned boards and spaces resolve real IDs, so a brief never guesses which board you meant. Nothing can comment, transition an issue, or edit a page.",
    },
    {
      number: "06",
      tone: "danger",
      mark: "web",
      brand: "Bright Data",
      title: "Look it up on the web",
      description: "Web search and page reading run server-side through Bright Data's MCP server, for public facts like opening hours or the news. The assistant reads only pages its own search returned or links someone in the conversation sent.",
      route: ["Search", "Read", "Answer"],
      note: "A daily lookup cap bounds it, group chats share a quarter of that, and nothing it reads is indexed.",
    },
  ] as const;
  const activeStory = story[activeStep];
  return <div className="page setup-page">
    <PageHead eyebrow="How it works" title="One thought. One clear path." description="Fieldnote turns conversation into action without turning your data into a black box." />
    <section className="story-machine">
      <nav aria-label="System flow">
        {story.map((step, index) => <button
          key={step.label}
          className={activeStep === index ? "active" : ""}
          onClick={() => setActiveStep(index)}
          aria-current={activeStep === index ? "step" : undefined}
        >
          <span>0{index + 1}</span><strong>{step.label}</strong><i/>
        </button>)}
      </nav>
      {/* Keyed on the step so the stage replays its reveal on every change. */}
      <article className="story-stage" key={activeStory.label}>
        <div className="story-step">Step 0{activeStep + 1} · {activeStory.label}</div>
        <h3>{activeStory.title}</h3>
        <p>{activeStory.description}</p>
        <div className="story-path">
          <span>{activeStory.path[0]}</span><ArrowRight size={14}/><span>{activeStory.path[1]}</span>
        </div>
        <footer><Check size={14}/>{activeStory.detail}</footer>
      </article>
      <aside className="story-aside">
        <div className="story-art-frame" key={activeStory.label}><StoryArt step={activeStep}/></div>
        <strong className="story-count">{activeStep + 1}<small>/ {story.length}</small></strong>
        <p>Every layer has one job. Step through the path to see where data moves and why.</p>
      </aside>
    </section>
    <section className="setup-section">
      <header>
        <div>
          <div className="eyebrow">What Fieldnote does</div>
          <h3>One private system.<br/>Four useful loops.</h3>
        </div>
        <p>Each feature returns to the same principle: SQLite owns the record; search helps you find it again.</p>
      </header>
      <div className="feature-ledger-grid">
        {features.map(feature => <article key={feature.number}>
          <span className="feature-ledger-number" aria-hidden="true">{feature.number}</span>
          <span className="feature-ledger-mark"><LoopMark name={feature.mark}/></span>
          <h4>{feature.title}</h4>
          <p>{feature.description}</p>
          <footer>{feature.route}<ArrowRight size={13}/></footer>
        </article>)}
      </div>
    </section>
    <section className="setup-section">
      <header>
        <div>
          <div className="eyebrow">Connections</div>
          <h3>Six doors into the same system.</h3>
        </div>
        <p>Messages land in the same SQLite tables and the same search index. Jira, Confluence, and the web are read live and never copied in.</p>
      </header>
      <div className="doors-grid">
        {doors.map(door => <article key={door.number} className={`door-card tone-${door.tone}`}>
          <div className="door-head">
            <span className="door-mark"><DoorMark name={door.mark}/></span>
            <strong>{door.brand}</strong>
            <span className="door-number" aria-hidden="true">{door.number}</span>
          </div>
          <h4>{door.title}</h4>
          <p>{door.description}</p>
          <div className="door-route">
            {door.route.map((leg, index) => <Fragment key={leg}>{index ? <i/> : null}<span>{leg}</span></Fragment>)}
          </div>
          <small>{door.note}</small>
        </article>)}
      </div>
      <p className="doors-security"><CheckCircle2 size={15}/>Provider secrets are encrypted in SQLite and never returned to the browser.</p>
    </section>
  </div>;
}
