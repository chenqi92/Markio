#import <Foundation/Foundation.h>
#import <StoreKit/StoreKit.h>
#import <stdlib.h>
#import <string.h>

char *markio_storefront_country_code(void) {
  @autoreleasepool {
    if (@available(macOS 10.15, *)) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      SKStorefront *storefront = [[SKPaymentQueue defaultQueue] storefront];
      NSString *countryCode = [storefront countryCode];
#pragma clang diagnostic pop
      if ([countryCode length] > 0) {
        const char *utf8 = [countryCode UTF8String];
        if (utf8 != NULL) {
          return strdup(utf8);
        }
      }
    }
  }
  return NULL;
}

void markio_free_c_string(char *ptr) {
  if (ptr != NULL) {
    free(ptr);
  }
}
