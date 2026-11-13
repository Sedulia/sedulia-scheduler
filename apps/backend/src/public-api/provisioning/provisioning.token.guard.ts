import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

// Opens the provisioning route to one caller: the holder of PROVISIONING_TOKEN.
//  * The variable unset or blank means the route does not exist (404), whatever the caller sends.
//  * The token is read from the environment at each request, never stored.
//  * The caller sends `Authorization: Bearer <token>` (that exact scheme), compared in constant time: both sides are
//    hashed to 32 bytes first, so a token of the wrong length is a plain 401 and the compare never leaks length.
@Injectable()
export class ProvisioningTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.PROVISIONING_TOKEN;
    if (typeof expected !== 'string' || expected.trim() === '') {
      throw new NotFoundException();
    }

    const header = context.switchToHttp().getRequest().headers?.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match || !timingSafeEqual(sha256(match[1]), sha256(expected))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
