// Everything the assistant knows about the business lives in this file.
// The website and the assistant both read it, so they can't disagree.
// To reuse this project for a client, replace this content and nothing else.

export type Service = { name: string; price: string; duration: string; details: string };
export type Faq = { question: string; answer: string };

export const business = {
  name: "Larkspur Cycle Works",
  assistantName: "Ask Larkspur",
  // Shown in the footer. Remove this for a real business.
  demoNotice: "Fictional business. A portfolio demo by [Ifeoluwa Oworu].",
  // Shows visitors a live "behind the scenes" panel of what the automation did.
  // Great for a portfolio demo. Turn it off for a real business.
  showActivityPanel: true,
  tagline: "Your bike, fixed by Friday.",
  intro:
    "A neighbourhood repair shop that answers at midnight. Ask the assistant for a price, or leave your details and we'll call you back.",
  address: "14 Larkspur Lane",
  phone: "555-0142",
  timezone: "America/New_York",
  hours: [
    { days: "Tuesday to Saturday", time: "9am to 6pm" },
    { days: "Sunday and Monday", time: "Closed" },
  ],
  services: [
    {
      name: "Standard tune-up",
      price: "$85",
      duration: "About 2 working days",
      details: "Adjusts brakes and gears, cleans and oils the chain, checks bolts and tyre pressure.",
    },
    {
      name: "Full overhaul",
      price: "$190",
      duration: "About 5 working days",
      details: "Bike stripped down, every part cleaned and inspected, then rebuilt. Replacement parts cost extra.",
    },
    {
      name: "Puncture repair",
      price: "$15 plus the inner tube ($8)",
      duration: "Same day if dropped off before 3pm",
      details: "Replaces the inner tube and checks the tyre for damage.",
    },
    {
      name: "Brake service",
      price: "$35 per wheel",
      duration: "Next working day",
      details: "New rim or disc pads fitted and adjusted. Pads are included.",
    },
  ] satisfies Service[],
  faqs: [
    {
      question: "Do you repair electric bikes?",
      answer: "Yes for brakes, tyres and gears. We don't repair e-bike motors or batteries.",
    },
    {
      question: "How can I pay?",
      answer: "Card or cash at collection. No deposit is needed for standard work.",
    },
    {
      question: "Do you collect bikes?",
      answer: "Not at the moment. Bikes need to be dropped off at the shop.",
    },
    {
      question: "Is the work guaranteed?",
      answer: "Labour is guaranteed for 30 days. If something we adjusted slips, we fix it free.",
    },
    {
      question: "Can you give an exact price for unusual damage?",
      answer: "No. Crash damage, frame damage and unusual faults need a mechanic to inspect the bike first.",
    },
  ] satisfies Faq[],
} as const;
