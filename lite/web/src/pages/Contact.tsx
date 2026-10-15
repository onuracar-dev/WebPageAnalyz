import { TerrainBackdrop } from '../backdrop/TerrainBackdrop';
import { api } from '../api';
import { ContactForm } from '../components/contact/ContactForm';

export function Contact() {
  const topic = new URLSearchParams(window.location.search).get('topic') ?? undefined;
  return (
    <>
      <TerrainBackdrop scene="results" />
      <main className="contact-page">
        <ContactForm
          defaultTopic={topic}
          onSubmit={async (message, honeypot) => {
            await api.contact(message, honeypot);
          }}
        />
      </main>
    </>
  );
}
