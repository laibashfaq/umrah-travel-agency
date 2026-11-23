import { Logo } from '@/components/brand/logo';
import { Card } from '@/components/ui/card';

/** Centered card used by every authentication page. */
export function AuthCard({ title, description, children, footer }: { title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-8 flex justify-center"><Logo /></div>
      <Card className="gap-6 p-6 shadow-elevated sm:p-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {children}
      </Card>
      {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
    </div>
  );
}
