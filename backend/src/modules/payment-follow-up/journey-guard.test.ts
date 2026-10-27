import assert from 'node:assert/strict';
import { it } from 'node:test';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH:'/dev/null', SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'fake-only',
  CUSTOMER_APPROVAL_MODE:'dashboard',DELIVERY_MODE:'test',TMT_MATERIAL_CONTROL_MODE:'dashboard',SAP_TMT_MATERIAL_IDS:'30000123',
  SAP_API_BASE_URL:'http://127.0.0.1:2/sap/opu/odata/sap',SAP_API_USERNAME:'fake',SAP_API_PASSWORD:'fake',SAP_EXPECTED_HOST:'127.0.0.1',
  WHATSAPP_TEST_RECIPIENTS:'917019339764',PAYMENT_TEST_RECIPIENTS:'917019339764',
});
const { assertManualJourneyAllowed } = await import('./journey-guard.js');
const { startJourneySchema, listEligiblePaymentInvoices } = await import('./manual-journeys.js');
const { env } = await import('../../config/env.js');

it('requires explicit unpaid confirmation, a real balance, and the expected due-days value', () => {
  const valid={confirmedUnpaid:true,outstandingAmount:700,expectedDueDays:3};
  assert.ok(startJourneySchema.safeParse(valid).success);
  for(const change of [{confirmedUnpaid:false},{outstandingAmount:0},{outstandingAmount:NaN},{outstandingAmount:1.001},{expectedDueDays:0},{recipient:'919999999999'}]) assert.equal(startJourneySchema.safeParse({...valid,...change}).success,false);
});

it('eligible discovery is read-only and excludes paid, started, future, pre-cutoff and Off-material invoices',async(t)=>{
  const writes:string[]=[];
  const http=t.mock.method(globalThis,'fetch',async(input: Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;
    if((init?.method??'GET')!=='GET'){writes.push(path);throw new Error('Discovery must never write');}
    if(path.includes('customer_messaging_settings'))return Response.json([
      {sap_customer_number:'510191',enabled:true,approved_phone:'918098868251',enabled_at:'2026-10-20T00:00:00Z'},
      {sap_customer_number:'OTHER',enabled:false,approved_phone:'919999999999',enabled_at:'2026-10-20T00:00:00Z'},
    ]);
    if(path.includes('system_settings'))return Response.json({settings:{payment_reminders:{dueDays:3,firstReminderDelaySeconds:120,repeatReminderDelaySeconds:180,maximumReminders:3},tmt_material_controls:{version:1,materials:{}}}});
    if(path.endsWith('/customers'))return Response.json([{sap_customer_number:'510191',display_name:'CASTLE BUILDERS'}]);
    if(path.endsWith('/invoices'))return Response.json([
      {sap_billing_document:'STARTED',payment_follow_up_cases:{id:1}},
      {sap_billing_document:'PAID',invoice_receivables:{payment_status:'paid',outstanding_amount:0}},
    ]);
    if(path.endsWith('/A_BillingDocument'))return Response.json({d:{results:[
      ...['ELIGIBLE','STARTED','PAID','OFF'].map(BillingDocument=>({BillingDocument,BillingDocumentDate:'2026-10-24',CreationDate:'2026-10-24',CreationTime:'PT14H0M0S',TotalGrossAmount:'1000',TransactionCurrency:'INR'})),
      {BillingDocument:'OLD',BillingDocumentDate:'2026-10-19',CreationDate:'2026-10-24',CreationTime:'PT14H0M0S',TransactionCurrency:'INR'},
      {BillingDocument:'FUTURE',BillingDocumentDate:'2099-01-01',CreationDate:'2026-10-24',CreationTime:'PT14H0M0S',TransactionCurrency:'INR'},
    ]}});
    if(path.endsWith('/A_BillingDocumentItem'))return Response.json({d:{results:[{BillingDocumentItem:'10',Material:new URL(String(input)).searchParams.get('$filter')?.includes("'OFF'")?'30000032':'30000123'}]}});
    throw new Error('Unexpected discovery request: '+path);
  });
  try {
    const rows=await listEligiblePaymentInvoices();
    assert.deepEqual(rows.map(row=>row.invoiceNumber),['ELIGIBLE']);
    assert.equal(rows[0]!.paymentStatus,'unverified');
    assert.equal(rows[0]!.dueDate,'2026-10-27');
    assert.equal(rows[0]!.customerName,'CASTLE BUILDERS');
    assert.deepEqual(writes,[]);
  }finally{http.mock.restore();}
});

type Changes = { enabled?:boolean; status?:string; amount?:number; phone?:string; cancelled?:boolean; stopDuringSap?:boolean; source?:string; approvedRecipient?:string; tmt?:boolean; snapshot?:boolean; invoiceDate?:string };
for (const [label,changes,allowed] of [
  ['exact approved SAP customer outside old payment-test list',{},true],
  ['disabled customer',{enabled:false},false],
  ['paid journey',{status:'resolved'},false],
  ['paused journey',{status:'paused'},false],
  ['zero balance',{amount:0},false],
  ['balance changed after queuing',{amount:600},false],
  ['SAP phone changed',{phone:'919999999999'},false],
  ['cancelled SAP invoice',{cancelled:true},false],
  ['paid while SAP lookup is running',{stopDuringSap:true},false],
  ['forged test balance marked manual',{source:'test_fixture'},false],
  ['different queued recipient',{approvedRecipient:'919999999999'},false],
  ['disabled material',{tmt:false},false],
  ['missing rules snapshot',{snapshot:false},false],
  ['pre-cutoff invoice',{invoiceDate:'2026-10-19'},false],
] as [string,Changes,boolean][]) it(`manual dispatch checks ${label}`,async(t)=>{
  let status=changes.status??'active';
  let providerCalls=0;
  const http=t.mock.method(globalThis,'fetch',async(input: Parameters<typeof fetch>[0])=>{
    const u=new URL(String(input));
    const path=u.pathname;
    if(path.includes('payment_follow_up_cases'))return Response.json({id:1,invoice_id:2,status,resolved_at:status==='resolved'?'2026-10-27T00:00:00Z':null});
    if(path.includes('invoice_receivables'))return Response.json({outstanding_amount:changes.amount??700,payment_status:'open',due_date:'2026-10-27',raw_data:{source:changes.source??'user_confirmed',manual_payment_journey:true,journey_case_id:1,payment_test_cycle_id:'manual-journey-1',approved_recipient:changes.approvedRecipient??'918098868251',...(changes.snapshot===false?{}:{journey_settings:{dueDays:3,firstReminderDelaySeconds:120,repeatReminderDelaySeconds:180,maximumReminders:3}})}});
    if(path.endsWith('/invoices'))return Response.json({id:2,sold_to_customer_id:1,sap_billing_document:'26ST000042',billing_document_type:'F2',billing_document_date:changes.invoiceDate??'2026-10-24',creation_datetime:'2026-10-24T14:00:00Z',is_cancelled:false,customers:[{sap_customer_number:'510191'}]});
    if(path.includes('customer_contacts'))return Response.json({id:1});
    if(path.includes('invoice_items'))return Response.json([{product_id:'30000123'}]);
    if(path.includes('system_settings'))return Response.json({settings:{tmt_material_controls:{version:1,materials:{'30000123':{enabled:changes.tmt??true,description:'TMT',updatedAt:'2026-10-20T00:00:00Z',updatedBy:'test'}}}}});
    if(path.includes('customer_messaging_settings'))return Response.json({sap_customer_number:'510191',enabled:changes.enabled??true,approved_phone:'918098868251',enabled_at:'2026-10-20T00:00:00Z'});
    if(path.includes('internal_test_recipients'))return Response.json(null);
    if(path.endsWith('/A_BillingDocument')){if(changes.stopDuringSap)status='resolved';return Response.json({d:{results:[{BillingDocument:'26ST000042',SoldToParty:'510191',BillingDocumentIsCancelled:changes.cancelled??false}]}});}
    if(path.endsWith('/A_Customer'))return Response.json({d:{results:[{Customer:'510191'}]}});
    if(path.endsWith('/A_BusinessPartnerAddress'))return Response.json({d:{results:[{AddressID:'1'}]}});
    if(path.endsWith('/A_AddressPhoneNumber'))return Response.json({d:{results:[{PhoneNumber:changes.phone??'918098868251',IsDefaultPhoneNumber:true}]}});
    providerCalls++; throw new Error('Unexpected non-mocked request: '+path);
  });
  try {
    const check=()=>assertManualJourneyAllowed(1,2,'918098868251','manual-journey-1',700);
    if(allowed) await check(); else await assert.rejects(check());
    assert.equal(providerCalls,0);
  }finally{http.mock.restore();}
});

it('manual mode never auto-starts a journey when an invoice is delivered',async(t)=>{
  const { handOffSentInvoiceToPaymentSchedule }=await import('./handoff.js');
  assert.equal(env.PAYMENT_JOURNEY_MODE,'manual');
  const http=t.mock.method(globalThis,'fetch',async(input: Parameters<typeof fetch>[0],init?:RequestInit)=>{
    assert.equal(init?.method??'GET','GET','Invoice delivery must not write a journey');
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/communication_jobs'))return Response.json({id:1,job_type:'invoice_delivery',customer_id:1,primary_invoice_id:2,metadata:{actual_recipient:'918098868251'}});
    if(path.endsWith('/customers'))return Response.json({id:1,sap_customer_number:'510191',display_name:'Castle'});
    if(path.endsWith('/invoices'))return Response.json({id:2,sap_billing_document:'26ST000042'});
    if(path.endsWith('/invoice_documents'))return Response.json({id:1});
    if(path.endsWith('/provider_integrations'))return Response.json({id:1});
    throw new Error('Unexpected read during invoice handoff '+path);
  });
  try { await handOffSentInvoiceToPaymentSchedule(1,'2026-10-27T00:00:00Z'); }
  finally { http.mock.restore(); }
});
