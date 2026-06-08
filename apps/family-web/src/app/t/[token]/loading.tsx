import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton de carga mientras el servidor resuelve la vista del viaje. */
export default function TrackingLoading() {
  return (
    <main className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row lg:overflow-hidden">
      <section className="h-[52dvh] w-full shrink-0 lg:h-full lg:flex-1">
        <Skeleton className="size-full rounded-none" />
      </section>
      <aside className="flex w-full flex-1 flex-col gap-3 p-4 lg:max-w-md lg:flex-none">
        <div className="rounded-lg border border-border bg-surface p-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-3 h-6 w-44" />
          <Skeleton className="mt-3 h-5 w-52" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-5">
          <Skeleton className="h-4 w-24" />
          <div className="mt-3 flex items-center gap-3">
            <Skeleton className="size-11 rounded-full" />
            <div className="flex-1">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="mt-2 h-4 w-16" />
            </div>
          </div>
        </div>
        <Skeleton className="h-11 w-full" />
      </aside>
    </main>
  );
}
