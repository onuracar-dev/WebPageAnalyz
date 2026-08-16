import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, FileLock2 } from 'lucide-react';
import { apiFetch } from './portal/api';

export type LegalKind = 'terms' | 'privacy' | 'kvkk' | 'acceptable-use' | 'refund' | 'subprocessors';

type LegalDocumentConfig = {
  id?: string;
  version?: string;
  effectiveAt?: string;
  path?: string;
};

type OperatorConfig = {
  name?: string;
  type?: string;
  legalName?: string;
  tradeName?: string;
  registrationNumber?: string;
  taxNumber?: string;
  businessAddress?: string;
  address?: string;
  country?: string;
  supportEmail?: string;
  supportPhone?: string;
  privacyEmail?: string;
  kvkkContactEmail?: string;
  effectiveDate?: string;
};

type SubprocessorConfig = {
  provider?: string;
  name?: string;
  purpose?: string;
  dataCategories?: string[];
  processingLocations?: string[];
  privacyUrl?: string;
  routing?: string;
};

export type PublicLegalConfig = {
  ready?: boolean;
  operator?: OperatorConfig;
  documents?: Record<string, LegalDocumentConfig>;
  subprocessors?: SubprocessorConfig[];
  billing?: {
    provider?: string;
    merchantOfRecord?: boolean | string | null;
    merchantOfRecordName?: string;
    buyerTermsUrl?: string;
    refundPolicyUrl?: string;
    buyerSupportUrl?: string;
    currency?: string;
    interval?: string;
    cancellationSummary?: string;
    enterpriseSalesMode?: string;
    recurring?: boolean;
    termsPath?: string;
    refundPath?: string;
    cancellationPath?: string;
  };
  retentionSummary?: string;
  internationalTransferSummary?: string;
};

/**
 * The public endpoint intentionally exposes deployment-safe field names. Keep
 * the rest of the UI on one canonical shape while accepting the original
 * fixture shape during a rolling deployment.
 */
export function normalizeLegalConfig(input: PublicLegalConfig): PublicLegalConfig {
  const sourceOperator = input.operator;
  const operator = sourceOperator ? {
    ...sourceOperator,
    legalName: sourceOperator.legalName || sourceOperator.name,
    address: sourceOperator.address || sourceOperator.businessAddress,
    privacyEmail: sourceOperator.privacyEmail || sourceOperator.kvkkContactEmail || sourceOperator.supportEmail,
    kvkkContactEmail: sourceOperator.kvkkContactEmail || sourceOperator.privacyEmail || sourceOperator.supportEmail,
  } : undefined;
  const effectiveAt = sourceOperator?.effectiveDate;
  const documents = Object.fromEntries(Object.entries(input.documents || {}).map(([key, document]) => [key, {
    ...document,
    effectiveAt: document.effectiveAt || effectiveAt,
  }]));
  const subprocessors = (input.subprocessors || []).map((processor) => ({
    ...processor,
    name: processor.name || processor.provider,
  }));
  const billing = input.billing ? {
    ...input.billing,
    merchantOfRecordName: input.billing.merchantOfRecordName
      || (typeof input.billing.merchantOfRecord === 'string' ? input.billing.merchantOfRecord : undefined)
      || (input.billing.merchantOfRecord ? input.billing.provider : undefined),
  } : undefined;

  return { ...input, operator, documents, subprocessors, billing };
}

const DOCUMENT_KEY: Record<LegalKind, string> = {
  terms: 'terms',
  privacy: 'privacy',
  kvkk: 'kvkk',
  'acceptable-use': 'acceptableUse',
  refund: 'refund',
  subprocessors: 'subprocessors',
};

const TITLES: Record<LegalKind, { index: string; eyebrow: string; title: string }> = {
  terms: { index: '06 / TERMS', eyebrow: 'SERVICE AGREEMENT', title: 'Terms of Service' },
  privacy: { index: '07 / PRIVACY', eyebrow: 'DATA PRACTICES', title: 'Privacy Notice' },
  kvkk: { index: '08 / KVKK', eyebrow: 'AYDINLATMA METNİ', title: 'KVKK Aydınlatma Metni' },
  'acceptable-use': { index: '09 / ACCEPTABLE USE', eyebrow: 'SAFETY BOUNDARY', title: 'Acceptable Use Policy' },
  refund: { index: '10 / REFUNDS', eyebrow: 'BILLING TERMS', title: 'Cancellation and Refund Policy' },
  subprocessors: { index: '11 / SUBPROCESSORS', eyebrow: 'PROCESSOR REGISTER', title: 'Subprocessors' },
};

function readableDate(value?: string) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleDateString(undefined, { dateStyle: 'long' });
}

function safeExternalUrl(value?: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}

function safeInternalPath(value?: string, fallback = '') {
  return value && /^\/[A-Za-z0-9/_-]*(?:\?[A-Za-z0-9=&._-]*)?$/.test(value) ? value : fallback;
}

function ConfigValue({ label, children }: { label: string; children?: ReactNode }) {
  if (!children) return null;
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function OperatorIdentity({ operator }: { operator: OperatorConfig }) {
  return <dl className="aux-legal__identity">
    <ConfigValue label="Service operator">{operator.legalName}</ConfigValue>
    <ConfigValue label="Operator type">{operator.type}</ConfigValue>
    <ConfigValue label="Trading name">{operator.tradeName}</ConfigValue>
    <ConfigValue label="Registration">{operator.registrationNumber}</ConfigValue>
    <ConfigValue label="Tax number">{operator.taxNumber}</ConfigValue>
    <ConfigValue label="Address">{operator.address}</ConfigValue>
    <ConfigValue label="Country">{operator.country}</ConfigValue>
    <ConfigValue label="Support"><a href={`mailto:${operator.supportEmail}`}>{operator.supportEmail}</a>{operator.supportPhone ? ` · ${operator.supportPhone}` : ''}</ConfigValue>
  </dl>;
}

function Terms({ config }: { config: PublicLegalConfig }) {
  const operator = config.operator || {};
  const merchant = config.billing?.merchantOfRecordName || config.billing?.provider;
  return <>
    <h2>The agreement and the service</h2>
    <p>These Terms govern the hosted WebPageAnalyz website-analysis and reporting service operated by {operator.legalName}. Creating an account or using a workspace does not transfer the software or its source code to you.</p>
    <OperatorIdentity operator={operator} />
    <h3>Accounts and authority</h3>
    <ul><li>Keep account credentials and recovery links secure and provide accurate account information.</li><li>Submit only websites, subdomains, source packages and journey steps that you own or have explicit permission to test.</li><li>Target authorization is recorded separately from DNS verification. DNS verification unlocks ownership-only engines but never replaces your permission obligation.</li></ul>
    <h3>Automated analysis boundaries</h3>
    <p>Results may combine measured signals, automated checks and heuristic or AI-suggested remediation. They can be partial, delayed, unavailable or incorrect and are not accessibility certification, penetration-test certification, legal advice, or a guarantee of security. Review evidence and suggestions before relying on or applying them. Expert Review is a separately assigned human workflow and is not guaranteed by a plan name alone.</p>
    <h3>Plans, recurring billing and cancellation</h3>
    <p>Free access is bounded. Signal and Studio are self-serve recurring subscriptions; Enterprise is contact and invitation only. Before a paid checkout opens, WPA shows the server-confirmed plan, price, currency and interval and requires acknowledgement of recurring billing, these Terms and the Refund Policy. {merchant ? `${merchant} acts as the merchant of record for configured paid checkout.` : 'The configured checkout must identify its merchant of record before a purchase can start.'} Cancellation stops renewal at the end of the current paid period unless the checkout or mandatory law states otherwise.</p>
    <h3>Credits, temporary grants and redeem codes</h3>
    <p>Page and AI credits are service-use counters, not money, stored value or transferable property. Bonus credits, redeem-code benefits and operator-assigned entitlements are governed by their recorded scope, limits and expiry. A temporary grant does not rewrite the underlying paid subscription, and an expired, disabled, exhausted or already-used code does not create continuing access.</p>
    <h3>Your targets, content and source packages</h3>
    <p>You retain your rights in material you submit. You grant WPA only the permission needed to validate, stage, analyze, report, secure and delete that material through the selected workflow. You must have the rights and authority to submit target URLs, authorized subdomains, evidence, journey definitions and source packages. Do not submit third-party secrets, production credentials or payment-card data.</p>
    <h3>Acceptable use, suspension and termination</h3>
    <p>The <a href="/acceptable-use">Acceptable Use Policy</a> forms part of these Terms. WPA may reject or suspend requests that exceed bounded limits, leave authorized scope, threaten service integrity, or violate law or third-party rights. You can request workspace export or deletion through the available account workflow; legal, fraud-prevention, security and backup obligations may require limited retention.</p>
    <h3>Availability, third-party services and retention</h3>
    <p>Queue capacity, rate limits, plan credits, provider availability and bounded analyzer limits apply. WPA does not promise uninterrupted service or a service level that has not been separately agreed. Configured authentication, infrastructure, email, billing, analysis and AI providers may process the minimum data needed for their role; the current categories appear in the <a href="/subprocessors">Subprocessor Register</a>. {config.retentionSummary || 'Retention follows the configured account, report, support, security-log and backup lifecycle; no instant-deletion promise is made.'}</p>
    <h3>Scope of reports and suggestions</h3>
    <p>Security results are passive hygiene signals, accessibility checks are automated and incomplete, and SEO, GEO, performance, source and browser evidence reflect only the requested pages, devices, time and available engines. No result is exhaustive, a verified repair, legal/compliance certification, or a substitute for professional review. AI output is suggested remediation and may be unavailable or wrong.</p>
    <h3>Billing support and refunds</h3>
    <p>Review the <a href="/refund">Cancellation and Refund Policy</a> before purchase. Nothing in these Terms removes non-waivable consumer rights.</p>
    <h3>Warranty, responsibility and applicable rules</h3>
    <p>To the extent permitted by law, WPA is provided on an “as available” basis without a promise that every issue will be found or that suggested changes will achieve a particular outcome. Nothing excludes liability or remedies that cannot lawfully be excluded. You remain responsible for target authority, deployment decisions and independent review of results. The service is administered by the operator identified above from {operator.country}; mandatory consumer, jurisdiction and conflict-of-law rules remain unaffected, and these Terms do not invent a forum or liability cap that the operator has not published.</p>
    <p>Questions, notices and account-support requests can be sent to <a href={`mailto:${operator.supportEmail}`}>{operator.supportEmail}</a>.</p>
  </>;
}

function Privacy({ config }: { config: PublicLegalConfig }) {
  const operator = config.operator || {};
  return <>
    <h2>Who controls the data</h2>
    <p>{operator.legalName} is the controller for account, workspace, support and service-operation data described here. Contact <a href={`mailto:${operator.privacyEmail}`}>{operator.privacyEmail}</a> for privacy requests.</p>
    <OperatorIdentity operator={operator} />
    <h3>Data handled by WPA</h3>
    <ul><li>Account identity and authentication state, including name, email, password credentials handled by the authentication service, sessions, IP address, user agent, recovery and multi-factor state.</li><li>Workspace membership, target origins, authorization attestations, DNS-verification state, scan requests, discovered URLs, reports, findings, evidence, shares and exports.</li><li>Billing identifiers, subscription and transaction state supplied by the configured merchant of record; WPA does not ask the browser to send full payment-card details to WPA.</li><li>Plan usage, reserved/consumed credits, redeem-code redemption and temporary entitlement state.</li><li>Support tickets, messages, target/report references, transactional-email delivery metadata and integration configuration when you choose those workflows.</li><li>Uploaded source archives, extracted dependency inventory, encrypted staging references and source-audit results when source analysis is enabled; uploaded scripts are not intentionally executed by that workflow.</li><li>Minimized finding and technical-evidence fields, requested/actual model, token/cost/latency and routing metadata when an AI suggestion is requested. Raw page/source content and secrets are not intended AI inputs.</li><li>Security, audit, rate-limit, worker and operational logs needed to prevent abuse and diagnose failures.</li></ul>
    <h3>Purposes and legal grounds</h3>
    <p>WPA processes this data to perform the requested service and contract, authenticate and secure accounts, enforce authorization and service limits, provide billing/support, comply with legal duties, and pursue legitimate interests in fraud prevention, reliability and auditability. Optional provider transfers occur only when you invoke the related workflow or the service needs the configured processor to perform the contract.</p>
    <h3>Cookies and browser storage</h3>
    <p>Authentication and security cookies are required to maintain a signed-in session and protect mutations. They are not presented as optional marketing consent. WPA must not activate optional analytics or advertising storage unless it is separately disclosed and, where required, consented to.</p>
    <h3>Sharing, transfers and retention</h3>
    <p>Processor categories and purposes are published in the <a href="/subprocessors">Subprocessor Register</a>. {config.internationalTransferSummary || 'The deployment must publish its applicable processing locations and transfer safeguards before production use.'}</p>
    <p>{config.retentionSummary || 'The deployment must publish its account, report, support, security-log and backup retention schedule before production use.'}</p>
    <h3>Your choices and rights</h3>
    <p>You may request access, correction, export, restriction, objection or deletion where applicable. Workspace export and deletion requests are authenticated operations; requests that cannot be completed in-product can be sent to the privacy contact above. Statutory complaint rights remain available.</p>
  </>;
}

function Kvkk({ config }: { config: PublicLegalConfig }) {
  const operator = config.operator || {};
  const contact = operator.kvkkContactEmail || operator.privacyEmail;
  return <>
    <h2>1. Veri sorumlusu</h2>
    <p>6698 sayılı Kişisel Verilerin Korunması Kanunu kapsamında veri sorumlusu {operator.legalName}’dir. Adres: {operator.address}, {operator.country}. KVKK başvuruları için: <a href={`mailto:${contact}`}>{contact}</a>.</p>
    <h3>2. İşlenen kişisel veriler</h3>
    <p>Kimlik ve iletişim bilgileri; hesap, oturum, IP ve kullanıcı aracısı gibi işlem güvenliği verileri; çalışma alanı ve hedef yetkilendirme kayıtları; tarama, rapor, bulgu ve destek içerikleri; abonelik/işlem durumu; seçilen entegrasyonlara ait yapılandırma ve denetim kayıtları işlenebilir.</p>
    <h3>3. İşleme amaçları ve hukuki sebepler</h3>
    <p>Veriler; üyelik ve hizmet sözleşmesinin kurulması/ifası, hesabın ve hizmetin güvenliği, yetki ve kota denetimi, destek ve faturalama süreçleri, hukuki yükümlülüklerin yerine getirilmesi, hakkın tesisi/kullanılması/korunması ve ölçülü meşru menfaatler kapsamında işlenir. Açık rıza gereken ayrı bir işlem olursa bu aydınlatma metninden bağımsız olarak alınır.</p>
    <h3>4. Toplama yöntemi</h3>
    <p>Veriler; web formları ve API istekleriyle otomatik, destek iletişimi ve yetkili operasyon işlemleriyle kısmen otomatik yollarla; ayrıca analiz için açık hedeflerden ve kullanıcının seçtiği sağlayıcılardan elde edilir.</p>
    <h3>5. Aktarım</h3>
    <p>Veriler yalnızca hizmetin sunulması, güvenlik, destek, e-posta, altyapı, yapay zekâ önerisi veya ödeme işlemi için gerekli ölçüde <a href="/subprocessors">yayınlanan alıcı gruplarına</a> aktarılır. {config.internationalTransferSummary || 'Yurt dışı aktarım konumu ve güvenceleri üretim ortamında ayrıca yapılandırılıp yayımlanmalıdır.'}</p>
    <h3>6. Kanun’un 11. maddesindeki haklar</h3>
    <p>Kişisel verilerinizin işlenip işlenmediğini öğrenme, bilgi talep etme, işleme amacını ve amaca uygun kullanımı öğrenme, aktarılan üçüncü kişileri bilme, eksik/yanlış verilerin düzeltilmesini veya şartları oluştuğunda silinmesini/yok edilmesini isteme, bu işlemlerin alıcılara bildirilmesini isteme, yalnızca otomatik analiz sonucu aleyhe bir sonuca itiraz etme ve kanuna aykırı işleme nedeniyle zararın giderilmesini talep etme haklarına sahipsiniz.</p>
    <p>Bu metin bir onay kutusu değildir. Aydınlatmanın sunulması ile açık rıza veya hizmet sözleşmesi kabulü birbirinden ayrıdır.</p>
  </>;
}

function AcceptableUse() {
  return <>
    <h2>Authorized, bounded analysis only</h2>
    <p>WPA is a website QA, automated analysis and passive security-hygiene service. It is not an exploitation, credential-attack or autonomous remediation platform.</p>
    <ul><li>Use WPA only for targets you own or have explicit permission to analyze. Record an accurate authorization attestation for every target and authorized subdomain.</li><li>Do not use WPA to enumerate random paths or subdomains, evade robots/scope controls, probe private networks, brute-force content or credentials, exploit vulnerabilities, bypass authentication, or access data not intended for you.</li><li>Do not submit malware, phishing content, destructive journey steps, denial-of-service traffic, credential-stuffing requests, secrets, session cookies, payment-card data, unlawfully obtained source packages, or material that violates third-party rights.</li><li>Do not use the scanner as attack automation, disrupt the service, facilitate illegal abuse, or bypass page-credit, queue, rate, sitemap, decompression, path-depth or provider limits.</li><li>Do not present automated, heuristic, passive-security or AI-suggested output as certification, verified repair, legal advice or a complete penetration test.</li></ul>
    <h3>Enforcement</h3>
    <p>Requests may be rejected, throttled, quarantined or suspended when they are outside authorized scope, unsafe, unlawful, abusive or technically unbounded. WPA may preserve narrowly necessary security evidence and cooperate with lawful requests. A suspension does not authorize destructive testing or broaden the service’s access.</p>
  </>;
}

function Refund({ config }: { config: PublicLegalConfig }) {
  const billing = config.billing || {};
  const buyerTerms = safeExternalUrl(billing.buyerTermsUrl) || 'https://www.paddle.com/legal/buyer-terms';
  const refundPolicy = safeExternalUrl(billing.refundPolicyUrl) || 'https://www.paddle.com/legal/refund-policy';
  const buyerSupport = safeExternalUrl(billing.buyerSupportUrl) || 'https://www.paddle.net/';
  const merchant = billing.merchantOfRecordName || billing.provider;
  const cancellationPath = safeInternalPath(billing.cancellationPath, '/app/settings/billing');
  return <>
    <h2>Recurring subscriptions and cancellation</h2>
    <p>Signal and Studio are recurring subscriptions. The confirmation step shows the server-confirmed amount, currency and billing interval before checkout. You can start cancellation from <a href={cancellationPath}>workspace billing settings</a> or the configured buyer portal; cancellation normally stops renewal and access continues until the end of the current paid period unless mandatory law or the checkout states otherwise. Enterprise is contact and invitation only.</p>
    <h3>Merchant of record</h3>
    <p>{merchant || 'The merchant named in the checkout confirmation'} is the merchant of record/reseller for configured paid checkout and handles payment collection, applicable taxes, invoices and eligible refund processing. Review the <a href={buyerTerms} rel="noreferrer">buyer terms</a>, <a href={refundPolicy} rel="noreferrer">refund policy</a> and <a href={buyerSupport} rel="noreferrer">buyer support portal</a>.</p>
    <h3>Refund requests and mandatory rights</h3>
    <p>Refund or withdrawal eligibility depends on the purchase, service delivery, the merchant-of-record policy and applicable mandatory law. WPA does not promise an absolute “no refunds” rule, does not claim sole authority over merchant-of-record refunds, and does not remove non-waivable consumer rights.</p>
    <h3>How to request help</h3>
    <p>Use the buyer support portal for payment/refund handling and contact <a href={`mailto:${config.operator?.supportEmail}`}>{config.operator?.supportEmail}</a> for product-access or service-delivery evidence. Include the transaction reference but never send complete card details.</p>
  </>;
}

function Subprocessors({ config }: { config: PublicLegalConfig }) {
  const entries = config.subprocessors || [];
  return <>
    <h2>Configured service providers</h2>
    <p>This register is generated from the deployment’s published legal configuration. Providers are used only for the purposes shown and remain subject to workspace scope and feature choice.</p>
    {entries.length ? <div className="aux-legal__processors">{entries.map((processor) => {
      const privacyUrl = safeExternalUrl(processor.privacyUrl);
      return <article key={`${processor.name}-${processor.purpose}`}><h3>{processor.name}</h3><p>{processor.purpose}</p><dl><ConfigValue label="Data categories">{processor.dataCategories?.join(', ')}</ConfigValue><ConfigValue label="Processing locations">{processor.processingLocations?.join(', ')}</ConfigValue><ConfigValue label="Routing note">{processor.routing}</ConfigValue></dl>{privacyUrl && <a href={privacyUrl} rel="noreferrer">Provider privacy information</a>}</article>;
    })}</div> : <div className="aux-legal__notice" role="alert"><AlertCircle /><div><strong>No processor register was returned.</strong><p>This deployment must publish its actual providers before customer data is processed.</p></div></div>}
  </>;
}

function DocumentBody({ kind, config }: { kind: LegalKind; config: PublicLegalConfig }) {
  if (kind === 'terms') return <Terms config={config} />;
  if (kind === 'privacy') return <Privacy config={config} />;
  if (kind === 'kvkk') return <Kvkk config={config} />;
  if (kind === 'acceptable-use') return <AcceptableUse />;
  if (kind === 'refund') return <Refund config={config} />;
  return <Subprocessors config={config} />;
}

export default function LegalContent({ kind }: { kind: LegalKind }) {
  const [config, setConfig] = useState<PublicLegalConfig | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiFetch<PublicLegalConfig>('/api/v1/legal/config')
      .then((result) => { if (!cancelled) setConfig(normalizeLegalConfig(result)); })
      .catch((requestError: unknown) => { if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Legal configuration could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const document = config?.documents?.[DOCUMENT_KEY[kind]];
  const operator = config?.operator;
  const billingReady = Boolean(config?.billing?.merchantOfRecord && (config.billing.merchantOfRecordName || config.billing.provider));
  const ready = Boolean(config?.ready && operator?.legalName && operator.address && operator.country && operator.supportEmail && operator.privacyEmail && document?.version && document.effectiveAt && (!['terms', 'refund'].includes(kind) || billingReady));
  const heading = TITLES[kind];
  const meta = useMemo(() => ready ? `Version ${document?.version} · effective ${readableDate(document?.effectiveAt)}` : 'Deployment configuration required', [document?.effectiveAt, document?.version, ready]);

  return <section className="aux-public__body aux-legal">
    <header className="aux-public__heading"><span className="aux-index">{heading.index}</span><div><span>{heading.eyebrow}</span><h1>{heading.title}</h1><p>{meta}</p></div></header>
    {loading ? <div className="aux-legal__notice" role="status"><FileLock2 /><div><strong>Loading the published legal configuration…</strong><p>Operator identity and document versions come from the server and are never guessed by the browser.</p></div></div>
      : !ready ? <div className="aux-legal__notice aux-legal__notice--blocked" role="alert"><AlertCircle /><div><strong>LEGAL CONFIGURATION UNAVAILABLE</strong><p>{error || 'This deployment did not return a complete operator identity and effective document version.'} No identity or binding version has been invented. Registration and paid checkout must remain unavailable until the server reports legal readiness.</p></div></div>
      : <article className="aux-legal__copy"><p className="aux-legal__publisher">Published by {operator?.legalName} · <a href={`mailto:${operator?.supportEmail}`}>{operator?.supportEmail}</a></p><DocumentBody kind={kind} config={config || {}} /><div className="aux-legal__meta"><span>Document: {document?.id || DOCUMENT_KEY[kind]}</span><span>Version {document?.version} · {readableDate(document?.effectiveAt)}</span></div></article>}
  </section>;
}
