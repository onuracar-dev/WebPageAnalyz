import { TerrainBackdrop } from '../backdrop/TerrainBackdrop';
import { ContactForm } from '../components/contact/ContactForm';

export function Contact() {
  const topic = new URLSearchParams(window.location.search).get('topic') ?? undefined;
  return (
    <>
      <TerrainBackdrop scene="results" />
      <main className="contact-page">
        <ContactForm defaultTopic={topic} />
      </main>
    </>
  );
}
