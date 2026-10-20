import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

const items = [
  {
    question: 'Do I need anything on the host besides SSH?',
    answer:
      'Yes: sshd plus docker or podman, and ports 80 and 443 free if you use the proxy. bundant speaks plain ssh and leaves nothing resident. Passwordless login is simplest; a deploy can also carry its own ssh block (user, port, identity, options) and need no local ssh config at all.',
  },
  {
    question: 'Does bundant need a registry?',
    answer:
      'No. With --local-image, bundant streams a locally built image to the host over the same ssh connection. If the image is in a registry, a normal deploy pulls the pinned tag.',
  },
  {
    question: 'Does this replace Kubernetes?',
    answer:
      'It replaces the single-host deployment slice of it. There is no scheduler, no multi-node orchestration and no CRDs. If you need a cluster, use a cluster; bundant is for the box you already own.',
  },
  {
    question: 'What about Windows hosts?',
    answer:
      'Not supported today. Target hosts need a Linux sshd with docker or podman. bundant bootstrap covers Debian/Ubuntu, the Fedora/RHEL family, Alpine, Arch and openSUSE.',
  },
];

export function FaqList() {
  return (
    <Accordion type="single" collapsible className="mt-8 rounded-xl border border-border bg-card px-5">
      {items.map((item, index) => (
        <AccordionItem key={item.question} value={`item-${index}`}>
          <AccordionTrigger>{item.question}</AccordionTrigger>
          <AccordionContent>{item.answer}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
