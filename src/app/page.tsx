import { business } from "@business";
import { ChatWidget } from "@/components/ChatWidget";
import { configuredProvider } from "@/lib/providers";

// Read per request, so switching AI_PROVIDER takes effect without a rebuild.
export const dynamic = "force-dynamic";

export default function Home() {
  const aiNotice =
    configuredProvider() === "gemini"
      ? "Replies come from Google Gemini, and Google may use chats to improve its products."
      : "Replies come from Anthropic's Claude.";
  return (
    <div className="site">
      <header className="site-nav">
        <div className="site-name">{business.name}</div>
        <nav className="site-links" aria-label="Main">
          <a href="#services">Services</a>
          <a href="#visit">Hours and address</a>
        </nav>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <h1>{business.tagline}</h1>
            <p>{business.intro}</p>
          </div>
          <svg className="wheel" aria-hidden="true" viewBox="0 0 250 250" fill="none" stroke="currentColor">
            <circle cx="125" cy="125" r="116" strokeWidth="12" />
            <circle cx="125" cy="125" r="100" strokeWidth="2" />
            <path
              strokeWidth="2"
              d="M125 25V225M25 125H225M54 54L196 196M196 54L54 196M87 33L163 217M163 33L87 217M33 87L217 163M33 163L217 87"
            />
            <circle cx="125" cy="125" r="16" fill="var(--tangerine)" stroke="none" />
          </svg>
        </section>

        <section className="section" id="services">
          <h2>Services</h2>
          <div className="services">
            {business.services.map((service) => (
              <article className="card" key={service.name}>
                <div className="card-title">{service.name}</div>
                <div className="card-text">{service.details}</div>
                <div className="card-text">{service.duration}</div>
                <div className="card-price">{service.price}</div>
              </article>
            ))}
          </div>
        </section>

        <section className="section" id="visit">
          <h2>Hours and address</h2>
          <div className="visit">
            <div className="card card-dark">
              <div className="card-title">Opening hours</div>
              {business.hours.map((entry) => (
                <div className="card-text" key={entry.days}>
                  {entry.days}: {entry.time}
                </div>
              ))}
            </div>
            <div className="card">
              <div className="card-title">Find us</div>
              <div className="card-text">{business.address}</div>
              <div className="card-text">{business.phone}</div>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">{business.demoNotice}</footer>
      <ChatWidget title={business.assistantName} showActivity={business.showActivityPanel} aiNotice={aiNotice} />
    </div>
  );
}
