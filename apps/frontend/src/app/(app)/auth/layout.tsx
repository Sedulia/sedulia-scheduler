import { getT } from '@gitroom/react/translation/get.translation.service.backend';

export const dynamic = 'force-dynamic';
import { ReactNode } from 'react';
import loadDynamic from 'next/dynamic';
import { LogoTextComponent } from '@gitroom/frontend/components/ui/logo-text.component';
import { LegalLinks } from '@gitroom/frontend/components/auth/legal.links';
import { MantineWrapper } from '@gitroom/react/helpers/mantine.wrapper';
import { Toaster } from '@gitroom/react/toaster/toaster';
const ReturnUrlComponent = loadDynamic(() => import('./return.url.component'));
export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getT();

  return (
    <MantineWrapper>
      <Toaster />
      <div className="bg-[#0E0E0E] flex flex-1 p-[12px] gap-[12px] min-h-screen w-screen text-white">
        <ReturnUrlComponent />
        <div className="flex flex-col py-[40px] px-[20px] flex-1 lg:w-[600px] lg:flex-none rounded-[12px] text-white p-[12px] bg-[#1A1919]">
          <div className="w-full max-w-[440px] mx-auto justify-center gap-[20px] h-full flex flex-col text-white">
            <LogoTextComponent />
            <div className="flex">{children}</div>
            {/* Terms and Privacy come from TERMS_URL and PRIVACY_URL, read here at request time; unset means no link */}
            <LegalLinks
              terms={process.env.TERMS_URL}
              privacy={process.env.PRIVACY_URL}
            />
          </div>
        </div>
        <div className="flex-1 hidden lg:flex flex-col items-center justify-center text-center px-[40px]">
          <div className="text-[48px] font-[600] -tracking-[1px]">
            Sedulia Social
          </div>
          <div className="mt-[12px] text-[20px] text-[#D1D1D1] max-w-[520px]">
            {t(
              'sedulia_social_tagline',
              'Plan, schedule and review your social posts in one place.'
            )}
          </div>
        </div>
      </div>
    </MantineWrapper>
  );
}
